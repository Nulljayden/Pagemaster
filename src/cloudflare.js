// Cloudflare Tunnels, owned per user.
//
// Two modes:
//  - "api":   the user gives a Cloudflare API token. Pagemaster creates the tunnel,
//             sets its public hostnames (ingress) and creates the DNS records itself.
//  - "token": the user pastes a tunnel token from the Zero Trust dashboard and sets
//             public hostnames there (service: http://localhost:<hosting port>).
//             Pagemaster runs cloudflared and maps the hostnames to sites.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const { db, save, id, encrypt, decrypt } = require('./db');

const procs = new Map(); // tunnelId -> { proc, stopping, restarts, timer }
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const SUB_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function httpError(status, msg) { return Object.assign(new Error(msg), { status }); }

// ---------------------------------------------------------------- Cloudflare API
// What each kind of call needs, so errors can say exactly which permission is missing
const STEP = {
  accounts: { what: 'list your accounts', perm: 'any Account permission (e.g. Account → Cloudflare Tunnel → Edit)' },
  zones: { what: 'list your domains', perm: 'Zone → Zone → Read' },
  dns: { what: 'manage DNS records', perm: 'Zone → DNS → Edit (with this domain included under Zone Resources)' },
  tunnel: { what: 'manage the tunnel', perm: 'Account → Cloudflare Tunnel → Edit' },
};
const AUTH_CODES = new Set([10000, 9109, 9103, 10001, 7003]);

async function cf(token, method, p, body, step) {
  let res;
  try {
    res = await fetch(config.CF_API_BASE + p, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw httpError(502, `Could not reach the Cloudflare API: ${e.message}`);
  }
  let data;
  try { data = await res.json(); } catch (_) { throw httpError(502, `Cloudflare API returned HTTP ${res.status}`); }
  if (!data.success) {
    const errs = data.errors || [];
    const msg = errs.map((e) => `${e.message} (${e.code})`).join('; ') || `HTTP ${res.status}`;
    const auth = res.status === 401 || res.status === 403 || errs.some((e) => AUTH_CODES.has(e.code));
    const st = STEP[step];
    const text = auth && st
      ? `Cloudflare refused to ${st.what}: ${msg}. The API token needs: ${st.perm}.`
      : `Cloudflare${st ? ` (${st.what})` : ''}: ${msg}`;
    const err = httpError(auth ? 400 : 502, text);
    err.cfAuth = auth;
    throw err;
  }
  return data;
}

async function cfAll(token, p, step) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const sep = p.includes('?') ? '&' : '?';
    const data = await cf(token, 'GET', `${p}${sep}page=${page}&per_page=50`, undefined, step);
    out.push(...(data.result || []));
    const info = data.result_info;
    if (!info || !info.total_pages || page >= info.total_pages) break;
  }
  return out;
}

// Look at what an API token can reach (used by the "add tunnel" form)
async function inspectToken(apiToken) {
  if (!apiToken) throw httpError(400, 'API token is required');
  const accounts = await cfAll(apiToken, '/accounts', 'accounts');
  if (!accounts.length) throw httpError(400, 'This token cannot see any Cloudflare account. Give it "Account - Cloudflare Tunnel - Edit".');
  return { accounts: accounts.map((a) => ({ id: a.id, name: a.name })) };
}

async function listZones(t) {
  const token = decrypt(t.apiToken);
  const zones = await cfAll(token, `/zones?account.id=${encodeURIComponent(t.accountId)}`, 'zones');
  return zones.map((z) => ({ id: z.id, name: z.name, status: z.status }));
}

function ingressFor(t) {
  return {
    config: {
      ingress: [
        ...(t.routes || []).map((r) => ({
          hostname: r.hostname,
          service: `http://localhost:${config.HOSTING_PORT}`,
          originRequest: { httpHostHeader: r.hostname },
        })),
        { service: 'http_status:404' },
      ],
    },
  };
}

async function pushIngress(t) {
  if (t.mode !== 'api') return;
  await cf(decrypt(t.apiToken), 'PUT', `/accounts/${t.accountId}/cfd_tunnel/${t.cfTunnelId}/configurations`, ingressFor(t), 'tunnel');
}

// ---------------------------------------------------------------- access helpers
function canAccess(user, t) {
  return !!user && (user.isAdmin || user.isLimitedAdmin || t.userId === user.id);
}

function get(user, tunnelId) {
  const t = db().tunnels.find((x) => x.id === tunnelId);
  if (!t || !canAccess(user, t)) throw httpError(404, 'Tunnel not found');
  return t;
}

function out(t) {
  const owner = db().users.find((u) => u.id === t.userId);
  const sites = db().sites;
  const p = procs.get(t.id);
  return {
    id: t.id,
    name: t.name,
    mode: t.mode,
    userId: t.userId,
    owner: owner ? owner.username : '(deleted user)',
    accountId: t.accountId || '',
    accountName: t.accountName || '',
    cfTunnelId: t.cfTunnelId || '',
    enabled: t.enabled !== false,
    status: t.status || 'stopped',
    running: !!(p && p.proc),
    lastError: t.lastError || '',
    createdAt: t.createdAt,
    routes: (t.routes || []).map((r) => {
      const s = sites.find((x) => x.id === r.siteId);
      return {
        id: r.id, hostname: r.hostname, siteId: r.siteId, siteName: s ? s.name : '(deleted)', siteSlug: s ? s.slug : '', zoneName: r.zoneName || '',
        dnsManual: !!r.dnsManual, dnsTarget: t.cfTunnelId ? `${t.cfTunnelId}.cfargotunnel.com` : '',
      };
    }),
  };
}

function list(user) {
  return db().tunnels.filter((t) => canAccess(user, t)).map(out);
}

// Every hostname already in use anywhere (custom domains, base-domain names, tunnel routes)
function hostnameOwner(hostname, ignoreRouteId) {
  const d = db();
  const base = (d.settings.sitesBaseDomain || '').toLowerCase();
  for (const s of d.sites) {
    if ((s.domains || []).includes(hostname)) return `custom domain of site "${s.name}"`;
    if (base && hostname === `${s.slug}.${base}`) return `site "${s.name}" (base domain)`;
  }
  for (const t of d.tunnels) {
    for (const r of t.routes || []) if (r.hostname === hostname && r.id !== ignoreRouteId) return `tunnel "${t.name}"`;
  }
  return null;
}

// ---------------------------------------------------------------- tunnel CRUD
async function create(user, body) {
  const name = String(body.name || '').trim().slice(0, 60);
  if (!/^[A-Za-z0-9 ._-]{1,60}$/.test(name)) throw httpError(400, 'Name: letters, numbers, spaces, . _ - (max 60)');
  const mode = body.mode === 'token' ? 'token' : 'api';
  const t = { id: id(), userId: user.id, name, mode, enabled: true, status: 'stopped', routes: [], createdAt: Date.now() };

  if (mode === 'token') {
    // Accept the bare token or any of Cloudflare's install commands
    // ("cloudflared service install <token>", "... run --token <token>", "TUNNEL_TOKEN=<token>"):
    // the token is the longest base64-looking chunk.
    const chunks = String(body.token || '').match(/[A-Za-z0-9+/=_-]{40,}/g) || [];
    const token = chunks.sort((a, b) => b.length - a.length)[0] || '';
    let valid = false;
    try { valid = !!JSON.parse(Buffer.from(token, 'base64').toString('utf8')).t; } catch (_) {}
    if (!valid) throw httpError(400, 'That does not look like a tunnel token. Copy the install command (or the token) from Zero Trust → Networks → Tunnels.');
    t.token = encrypt(token);
  } else {
    const apiToken = String(body.apiToken || '').trim();
    const accountId = String(body.accountId || '').trim();
    if (!apiToken || !/^[a-f0-9]{32}$/.test(accountId)) throw httpError(400, 'API token and account are required');
    const { accounts } = await inspectToken(apiToken);
    const acct = accounts.find((a) => a.id === accountId);
    if (!acct) throw httpError(400, 'That account is not accessible with this token');
    const tunnelName = `pagemaster-${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${t.id.slice(0, 6)}`;
    const created = await cf(apiToken, 'POST', `/accounts/${accountId}/cfd_tunnel`, { name: tunnelName, config_src: 'cloudflare' }, 'tunnel');
    const cfTunnelId = created.result.id;
    let token;
    try {
      token = (await cf(apiToken, 'GET', `/accounts/${accountId}/cfd_tunnel/${cfTunnelId}/token`, undefined, 'tunnel')).result;
    } catch (e) {
      await cf(apiToken, 'DELETE', `/accounts/${accountId}/cfd_tunnel/${cfTunnelId}`).catch(() => {});
      throw e;
    }
    Object.assign(t, { apiToken: encrypt(apiToken), accountId, accountName: acct.name, cfTunnelId, cfTunnelName: tunnelName, token: encrypt(token) });
    await pushIngress(t);
  }
  db().tunnels.push(t);
  save();
  start(t.id);
  return out(t);
}

async function remove(user, tunnelId) {
  const t = get(user, tunnelId);
  return destroy(t);
}

// Deletes a tunnel and (API mode) the DNS records + tunnel Pagemaster created
async function destroy(t) {
  const warnings = [];
  await stop(t.id);
  if (t.mode === 'api') {
    const token = decrypt(t.apiToken);
    for (const r of t.routes || []) {
      if (!r.dnsRecordId) continue;
      try { await cf(token, 'DELETE', `/zones/${r.zoneId}/dns_records/${r.dnsRecordId}`, undefined, 'dns'); } catch (e) { warnings.push(`DNS ${r.hostname}: ${e.message}`); }
    }
    try { await cf(token, 'DELETE', `/accounts/${t.accountId}/cfd_tunnel/${t.cfTunnelId}/connections`); } catch (_) { /* may have none */ }
    try { await cf(token, 'DELETE', `/accounts/${t.accountId}/cfd_tunnel/${t.cfTunnelId}`, undefined, 'tunnel'); } catch (e) { warnings.push(`Tunnel: ${e.message}`); }
  }
  const d = db();
  d.tunnels = d.tunnels.filter((x) => x.id !== t.id);
  save();
  try { fs.rmSync(logFile(t), { force: true }); } catch (_) {}
  return { ok: true, warnings };
}

async function addRoute(user, tunnelId, body) {
  const t = get(user, tunnelId);
  const site = db().sites.find((s) => s.id === body.siteId);
  if (!site) throw httpError(400, 'Choose a site');
  const route = { id: id(), siteId: site.id };

  if (t.mode === 'api') {
    const token = decrypt(t.apiToken);
    const zoneId = String(body.zoneId || '');
    let zone;
    try {
      zone = (await cf(token, 'GET', `/zones/${encodeURIComponent(zoneId)}`, undefined, 'zones')).result;
    } catch (e) {
      if (!e.cfAuth) throw e;
      zone = (await listZones(t)).find((z) => z.id === zoneId);
    }
    if (!zone || (zone.account && zone.account.id !== t.accountId)) throw httpError(400, 'Choose a domain (zone) from this Cloudflare account');
    const sub = String(body.subdomain ?? '').trim().toLowerCase().replace(/\.+$/, '');
    if (sub && !SUB_RE.test(sub)) throw httpError(400, 'Subdomain: letters, numbers, dashes (e.g. "blog" or "app.dev")');
    route.hostname = sub ? `${sub}.${zone.name}` : zone.name;
    route.zoneId = zone.id;
    route.zoneName = zone.name;
  } else {
    route.hostname = String(body.hostname || '').trim().toLowerCase().replace(/\.+$/, '');
  }
  if (!HOST_RE.test(route.hostname)) throw httpError(400, `Invalid hostname: ${route.hostname}`);
  const owner = hostnameOwner(route.hostname);
  if (owner) throw httpError(409, `${route.hostname} is already used by ${owner}`);

  let warning = null;
  if (t.mode === 'api') {
    const dns = await ensureDns(t, route);
    t.routes = [...(t.routes || []), route];
    try {
      await pushIngress(t);
    } catch (e) {
      t.routes = t.routes.filter((r) => r.id !== route.id);
      if (dns.created) await cf(decrypt(t.apiToken), 'DELETE', `/zones/${route.zoneId}/dns_records/${route.dnsRecordId}`, undefined, 'dns').catch(() => {});
      throw e;
    }
    if (!dns.ok) warning = manualDnsWarning(t, route, dns.error);
  } else {
    t.routes = [...(t.routes || []), route];
  }
  save();
  const o = out(t);
  if (warning) o.warning = warning;
  return o;
}

function dnsTarget(t) { return `${t.cfTunnelId}.cfargotunnel.com`; }

function manualDnsWarning(t, r, error) {
  return {
    message: `${r.hostname} is published on the tunnel, but Pagemaster could not create its DNS record. ${error}`,
    record: { type: 'CNAME', name: r.hostname, target: dnsTarget(t), proxied: true },
  };
}

// Make sure the hostname has a proxied CNAME to the tunnel.
// Permission problems don't fail the publish: the route is marked dnsManual and the
// user is shown the record to add by hand (or can fix the token and retry).
async function ensureDns(t, route) {
  const token = decrypt(t.apiToken);
  const target = dnsTarget(t);
  try {
    const existing = (await cf(token, 'GET', `/zones/${route.zoneId}/dns_records?name=${encodeURIComponent(route.hostname)}`, undefined, 'dns')).result || [];
    const clash = existing.find((r) => !(r.type === 'CNAME' && r.content === target));
    if (clash) {
      throw httpError(409, `Cloudflare already has a ${clash.type} record for ${route.hostname} (${clash.content}). Delete it in Cloudflare or pick another subdomain.`);
    }
    if (existing.length) {
      route.dnsRecordId = existing[0].id;
      delete route.dnsManual;
      return { ok: true, created: false };
    }
    const rec = await cf(token, 'POST', `/zones/${route.zoneId}/dns_records`, {
      type: 'CNAME', name: route.hostname, content: target, proxied: true, ttl: 1, comment: 'Managed by Pagemaster',
    }, 'dns');
    route.dnsRecordId = rec.result.id;
    delete route.dnsManual;
    return { ok: true, created: true };
  } catch (e) {
    if (!e.cfAuth) throw e;
    route.dnsManual = true;
    return { ok: false, error: e.message };
  }
}

// Replace the API token of an API-mode tunnel (e.g. to add the DNS permission),
// then retry anything that previously failed for lack of permission.
async function updateToken(user, tunnelId, apiToken) {
  const t = get(user, tunnelId);
  if (t.mode !== 'api') throw httpError(400, 'This tunnel uses a tunnel token, not an API token');
  apiToken = String(apiToken || '').trim();
  const { accounts } = await inspectToken(apiToken);
  if (!accounts.some((a) => a.id === t.accountId)) throw httpError(400, `The new token can't access the account "${t.accountName}" this tunnel belongs to`);
  t.apiToken = encrypt(apiToken);
  save();
  const warnings = [];
  try { await pushIngress(t); } catch (e) { warnings.push(e.message); }
  for (const r of t.routes || []) {
    if (!r.dnsManual) continue;
    try {
      const d = await ensureDns(t, r);
      if (!d.ok) warnings.push(`${r.hostname}: ${d.error}`);
    } catch (e) { warnings.push(`${r.hostname}: ${e.message}`); }
  }
  save();
  const o = out(t);
  o.warnings = warnings;
  return o;
}

async function removeRoute(user, tunnelId, routeId) {
  const t = get(user, tunnelId);
  const r = (t.routes || []).find((x) => x.id === routeId);
  if (!r) throw httpError(404, 'Route not found');
  await dropRoute(t, r);
  return out(t);
}

async function dropRoute(t, r) {
  const warnings = [];
  t.routes = (t.routes || []).filter((x) => x.id !== r.id);
  save();
  if (t.mode === 'api') {
    const token = decrypt(t.apiToken);
    try { await pushIngress(t); } catch (e) { warnings.push(e.message); }
    if (r.dnsRecordId) {
      try { await cf(token, 'DELETE', `/zones/${r.zoneId}/dns_records/${r.dnsRecordId}`, undefined, 'dns'); } catch (e) { warnings.push(e.message); }
    }
  }
  return warnings;
}

// Called before a site is deleted
async function removeSiteRoutes(siteId) {
  for (const t of db().tunnels) {
    for (const r of [...(t.routes || [])]) if (r.siteId === siteId) await dropRoute(t, r).catch(() => {});
  }
}

// Called when a user is deleted: their tunnels go with them
async function removeUserTunnels(userId) {
  for (const t of db().tunnels.filter((x) => x.userId === userId)) await destroy(t).catch(() => {});
}

// ---------------------------------------------------------------- cloudflared processes
function logFile(t) { return path.join(config.LOGS_DIR, `tunnel-${t.id}.log`); }

function tlog(t, msg) {
  try {
    const f = logFile(t);
    try { if (fs.statSync(f).size > 1024 * 1024) fs.renameSync(f, f + '.1'); } catch (_) {}
    fs.appendFileSync(f, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

function clearLog(user, tunnelId) {
  const t = get(user, tunnelId);
  fs.rmSync(logFile(t), { force: true });
}

function readLog(user, tunnelId) {
  const t = get(user, tunnelId);
  const f = logFile(t);
  if (!fs.existsSync(f)) return '';
  const buf = fs.readFileSync(f);
  return buf.slice(Math.max(0, buf.length - 150000)).toString('utf8');
}

function setStatus(t, status, lastError) {
  const cur = db().tunnels.find((x) => x.id === t.id);
  if (!cur) return;
  cur.status = status;
  if (lastError !== undefined) cur.lastError = lastError;
  save();
}

function start(tunnelId) {
  const t = db().tunnels.find((x) => x.id === tunnelId);
  if (!t || t.enabled === false) return;
  const p = procs.get(t.id) || { restarts: 0 };
  procs.set(t.id, p);
  if (p.proc) return;
  clearTimeout(p.timer);
  p.stopping = false;
  tlog(t, 'Starting cloudflared');
  setStatus(t, 'starting', '');
  let child;
  try {
    // Token goes in the environment, not the command line, so it doesn't show in `ps`
    child = spawn(config.CLOUDFLARED_BIN, ['tunnel', '--no-autoupdate', 'run'], {
      env: { ...process.env, TUNNEL_TOKEN: decrypt(t.token) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    setStatus(t, 'error', e.message);
    return;
  }
  p.proc = child;
  const started = Date.now();
  const onData = (b) => {
    const s = b.toString();
    try { fs.appendFileSync(logFile(t), s); } catch (_) {}
    if (/Registered tunnel connection/i.test(s)) setStatus(t, 'connected', '');
    else if (/Unauthorized|Invalid tunnel secret|token.*invalid|failed to unmarshal/i.test(s)) setStatus(t, 'error', 'Cloudflare rejected the tunnel token');
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => {
    tlog(t, `cloudflared error: ${e.message}`);
    setStatus(t, 'error', e.code === 'ENOENT' ? 'cloudflared is not installed in this container' : e.message);
  });
  child.on('exit', (code, sig) => {
    if (p.proc === child) p.proc = null;
    const cur = db().tunnels.find((x) => x.id === t.id);
    if (!cur) return;
    tlog(cur, `cloudflared exited (code ${code}${sig ? ', ' + sig : ''})`);
    if (p.stopping || cur.enabled === false) { setStatus(cur, 'stopped'); return; }
    if (Date.now() - started > 120000) p.restarts = 0;
    p.restarts++;
    const delay = Math.min(300, 5 * 2 ** Math.min(p.restarts, 6));
    if (cur.status !== 'error') setStatus(cur, 'error', `cloudflared stopped (code ${code}), retrying in ${delay}s`);
    p.timer = setTimeout(() => start(t.id), delay * 1000);
  });
}

function stop(tunnelId) {
  const p = procs.get(tunnelId);
  if (!p) return Promise.resolve();
  clearTimeout(p.timer);
  p.stopping = true;
  const child = p.proc;
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const k = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 8000);
    child.once('exit', () => { clearTimeout(k); resolve(); });
    try { child.kill('SIGTERM'); } catch (_) { resolve(); }
  });
}

async function setEnabled(user, tunnelId, enabled) {
  const t = get(user, tunnelId);
  t.enabled = enabled;
  save();
  if (enabled) { procs.delete(t.id); start(t.id); } else { await stop(t.id); setStatus(t, 'stopped', ''); }
  return out(t);
}

function startAll() {
  for (const t of db().tunnels) if (t.enabled !== false) start(t.id);
}

async function shutdown() {
  await Promise.all([...procs.keys()].map(stop));
}

module.exports = {
  clearLog,
  inspectToken, listZones, list, get, create, remove, addRoute, removeRoute,
  removeSiteRoutes, removeUserTunnels, updateToken, setEnabled, readLog, startAll, shutdown, hostnameOwner,
};
