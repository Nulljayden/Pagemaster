// Site management: cloning repos, building, serving and port/route conflict checks.
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const httpProxy = require('http-proxy');
const config = require('./config');
const { db, save, id, decrypt } = require('./db');

const runtime = new Map(); // siteId -> { deploying, queued, proc, stopping, restarts, server, serverPort, handler, handlerDir }
const proxy = httpProxy.createProxyServer({ xfwd: true, ws: true });
proxy.on('error', (err, _req, res) => {
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad gateway: site app is not responding (' + err.code + ')');
  } else if (res && res.destroy) {
    res.destroy();
  }
});

function rt(siteId) {
  if (!runtime.has(siteId)) runtime.set(siteId, { restarts: 0 });
  return runtime.get(siteId);
}

// ---------------------------------------------------------------- paths/logs
function repoDir(site) { return path.join(config.SITES_DIR, site.slug); }
function publishDir(site) { return path.join(repoDir(site), site.subdir || ''); }
function logFile(site) { return path.join(config.LOGS_DIR, `${site.id}.log`); }

function log(site, msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    const f = logFile(site);
    // keep log files from growing forever (~2MB)
    try { if (fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, f + '.1'); } catch (_) {}
    fs.appendFileSync(f, line);
  } catch (_) {}
}

function readLog(site, bytes = 200000) {
  const f = logFile(site);
  if (!fs.existsSync(f)) return '';
  const size = fs.statSync(f).size;
  const fd = fs.openSync(f, 'r');
  const len = Math.min(size, bytes);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

// ---------------------------------------------------------------- validation
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,200}$/;

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
}

function canBind(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    out[k] = line.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function hostsFor(site, baseDomain) {
  const hosts = [...(site.domains || [])];
  if (baseDomain) hosts.push(`${site.slug}.${baseDomain}`);
  return hosts.map((h) => h.toLowerCase());
}

// Validates input for a new or updated site. Throws Error with a user-facing message.
async function validate(input, existingId) {
  const d = db();
  const others = d.sites.filter((s) => s.id !== existingId);
  const current = d.sites.find((s) => s.id === existingId) || {};
  const errors = [];

  const name = String(input.name || '').trim();
  if (!name) errors.push('Name is required');

  const slug = String(input.slug || slugify(name)).trim().toLowerCase();
  if (!SLUG_RE.test(slug)) errors.push('Slug must be lowercase letters, numbers and dashes (max 40)');
  if (others.some((s) => s.slug === slug)) errors.push(`Slug/path "/${slug}/" is already used by another site`);

  const repoUrl = String(input.repoUrl || '').trim();
  if (!/^(https?:\/\/|ssh:\/\/|git:\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)/.test(repoUrl)) {
    errors.push('Repo URL must be https://, http://, ssh://, git:// or git@host:owner/repo');
  }
  if (/^https?:\/\/[^/]*@/.test(repoUrl)) errors.push('Do not put credentials in the URL - add a Git credential instead');

  const branch = String(input.branch || '').trim();
  if (branch && (!BRANCH_RE.test(branch) || branch.startsWith('-'))) errors.push('Invalid branch name');

  const subdir = String(input.subdir || '').trim().replace(/^\/+|\/+$/g, '');
  if (subdir && (subdir.split('/').includes('..') || path.isAbsolute(subdir))) errors.push('Publish directory must be inside the repo');

  const mode = input.mode === 'node' ? 'node' : 'static';
  const startCommand = String(input.startCommand || '').trim();
  if (mode === 'node' && !startCommand) errors.push('Start command is required for app sites');

  // Domains (virtual hosts on the shared hosting port)
  const domains = [...new Set((Array.isArray(input.domains) ? input.domains : String(input.domains || '').split(/[\s,]+/))
    .map((x) => x.trim().toLowerCase()).filter(Boolean))];
  for (const h of domains) if (!HOST_RE.test(h)) errors.push(`Invalid domain: ${h}`);
  const base = (d.settings.sitesBaseDomain || '').toLowerCase();
  const myHosts = hostsFor({ slug, domains }, base);
  for (const o of others) {
    const clash = hostsFor(o, base).filter((h) => myHosts.includes(h));
    if (clash.length) errors.push(`Domain ${clash.join(', ')} is already used by site "${o.name}"`);
  }

  // Dedicated port
  let port = null;
  if (input.port !== undefined && input.port !== null && String(input.port).trim() !== '') {
    port = parseInt(input.port, 10);
    const [lo, hi] = config.SITE_PORT_RANGE || [1, 65535];
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('Port must be a number 1-65535');
    else if (port === config.ADMIN_PORT) errors.push(`Port ${port} is the admin UI port`);
    else if (port === config.HOSTING_PORT) errors.push(`Port ${port} is the shared hosting port`);
    else if (port < lo || port > hi) errors.push(`Port must be within the published site port range ${lo}-${hi}`);
    else if (others.some((s) => s.port === port)) errors.push(`Port ${port} is already used by site "${others.find((s) => s.port === port).name}"`);
    else if (others.some((s) => s.internalPort === port)) errors.push(`Port ${port} is used internally by another site`);
    else if (current.port !== port && !(await canBind(port))) errors.push(`Port ${port} is already in use by another program`);
  }

  if (errors.length) {
    const e = new Error(errors.join('\n'));
    e.status = 400;
    throw e;
  }

  const autoPull = Math.max(0, Math.min(1440, parseInt(input.autoPullMinutes || 0, 10) || 0));
  return {
    name,
    slug,
    repoUrl,
    branch,
    credentialId: String(input.credentialId || 'auto'),
    subdir,
    mode,
    installCommand: String(input.installCommand || '').trim(),
    buildCommand: String(input.buildCommand || '').trim(),
    startCommand,
    env: String(input.env || ''),
    domains,
    port,
    spa: !!input.spa,
    autoPullMinutes: autoPull,
  };
}

async function allocInternalPort(siteId) {
  const used = new Set(db().sites.filter((s) => s.id !== siteId).flatMap((s) => [s.port, s.internalPort]));
  const [lo, hi] = config.APP_PORT_RANGE;
  for (let p = lo; p <= hi; p++) {
    if (used.has(p) || p === config.ADMIN_PORT || p === config.HOSTING_PORT) continue;
    if (await canBind(p, '127.0.0.1')) return p;
  }
  throw new Error('No free internal app ports');
}

// ---------------------------------------------------------------- git
function credentialFor(site) {
  const d = db();
  if (!site.credentialId || site.credentialId === 'none') return null;
  if (site.credentialId !== 'auto') return d.credentials.find((c) => c.id === site.credentialId) || null;
  let host = '';
  try { host = new URL(site.repoUrl).hostname.toLowerCase(); } catch (_) { return null; }
  return d.credentials.find((c) => (c.host || '').toLowerCase() === host) || null;
}

function gitEnv(site) {
  const key = path.join(config.SSH_DIR, 'id_ed25519');
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: `ssh -i ${key} -o UserKnownHostsFile=${path.join(config.SSH_DIR, 'known_hosts')} -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes -o BatchMode=yes`,
  };
  const cred = credentialFor(site);
  if (cred && /^https?:\/\//.test(site.repoUrl)) {
    const token = decrypt(cred.token);
    const user = cred.username || 'x-access-token';
    // Passed via env (not URL/args) so tokens never land in .git/config or `ps`
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = 'Authorization: Basic ' + Buffer.from(`${user}:${token}`).toString('base64');
  }
  return env;
}

function run(site, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const shown = opts.display || [cmd, ...args].join(' ');
    log(site, `$ ${shown}`);
    const p = spawn(cmd, args, { cwd: opts.cwd, env: opts.env || process.env, detached: true });
    let out = '';
    const onData = (b) => {
      const s = b.toString();
      out += s;
      if (out.length > 100000) out = out.slice(-50000);
      try { fs.appendFileSync(logFile(site), s); } catch (_) {}
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const timer = setTimeout(() => {
      log(site, `Timed out after ${(opts.timeout || 1200000) / 1000}s, killing`);
      try { process.kill(-p.pid, 'SIGKILL'); } catch (_) {}
    }, opts.timeout || 1200000);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${shown.split(' ').slice(0, 3).join(' ')} exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------- deploy
function setStatus(site, status, extra = {}) {
  const s = db().sites.find((x) => x.id === site.id);
  if (!s) return;
  Object.assign(s, { status }, extra);
  save();
}

async function deploy(siteId, opts = {}) {
  const r = rt(siteId);
  if (r.deploying) { r.queued = true; return { queued: true }; }
  r.deploying = true;
  try {
    let site = db().sites.find((s) => s.id === siteId);
    if (!site) return;
    const dir = repoDir(site);
    const env = gitEnv(site);
    const changed = await syncRepo(site, dir, env, opts);
    site = db().sites.find((s) => s.id === siteId);
    if (!site) return;
    if (!changed && opts.onlyIfChanged) { setStatus(site, site.status, { lastCheck: Date.now() }); return; }

    setStatus(site, 'deploying');
    const buildEnv = { ...process.env, ...parseEnv(site.env), CI: 'true' };
    if (site.installCommand) await run(site, 'sh', ['-c', site.installCommand], { cwd: dir, env: buildEnv, display: site.installCommand });
    if (site.buildCommand) await run(site, 'sh', ['-c', site.buildCommand], { cwd: dir, env: buildEnv, display: site.buildCommand });

    if (!fs.existsSync(publishDir(site))) throw new Error(`Publish directory "${site.subdir}" does not exist after build`);
    r.handler = null; // rebuild static handler
    if (site.mode === 'node' && site.enabled !== false) await startApp(site);
    const commit = (await run(site, 'git', ['log', '-1', '--format=%h %s'], { cwd: dir, env })).trim();
    log(site, `Deploy finished: ${commit}`);
    setStatus(site, site.enabled === false ? 'stopped' : 'live', { lastDeploy: Date.now(), lastCommit: commit, lastError: '', lastCheck: Date.now() });
  } catch (e) {
    const site = db().sites.find((s) => s.id === siteId);
    if (site) {
      log(site, `ERROR: ${e.message}`);
      setStatus(site, 'error', { lastError: e.message, lastCheck: Date.now() });
    }
  } finally {
    r.deploying = false;
    if (r.queued) { r.queued = false; setImmediate(() => deploy(siteId)); }
  }
}

// Returns true if the working tree changed (fresh clone or new commit)
async function syncRepo(site, dir, env, opts) {
  if (!fs.existsSync(path.join(dir, '.git'))) {
    setStatus(site, 'deploying');
    fs.rmSync(dir, { recursive: true, force: true });
    log(site, `Cloning ${site.repoUrl}${site.branch ? ' (' + site.branch + ')' : ''}`);
    const args = ['clone', '--depth', '1', '--single-branch'];
    if (site.branch) args.push('--branch', site.branch);
    args.push('--', site.repoUrl, dir);
    await run(site, 'git', args, { env });
    await submodules(site, dir, env);
    return true;
  }
  const before = (await run(site, 'git', ['rev-parse', 'HEAD'], { cwd: dir, env })).trim();
  await run(site, 'git', ['remote', 'set-url', 'origin', site.repoUrl], { cwd: dir, env });
  const ref = site.branch || 'HEAD';
  if (!opts.onlyIfChanged) log(site, `Pulling ${ref}`);
  await run(site, 'git', ['fetch', '--depth', '1', 'origin', ref], { cwd: dir, env });
  const remote = (await run(site, 'git', ['rev-parse', 'FETCH_HEAD'], { cwd: dir, env })).trim();
  if (opts.onlyIfChanged && remote === before) return false;
  if (opts.onlyIfChanged) log(site, `New commit detected (${remote.slice(0, 7)}), redeploying`);
  await run(site, 'git', ['reset', '--hard', 'FETCH_HEAD'], { cwd: dir, env });
  await run(site, 'git', ['clean', '-fd'], { cwd: dir, env });
  await submodules(site, dir, env);
  return remote !== before || !opts.onlyIfChanged;
}

async function submodules(site, dir, env) {
  if (fs.existsSync(path.join(dir, '.gitmodules'))) {
    await run(site, 'git', ['submodule', 'update', '--init', '--recursive', '--depth', '1'], { cwd: dir, env });
  }
}

// ---------------------------------------------------------------- app processes
async function startApp(site) {
  await stopApp(site.id);
  const r = rt(site.id);
  const s = db().sites.find((x) => x.id === site.id);
  if (!s.internalPort) { s.internalPort = await allocInternalPort(s.id); save(); }
  const env = { ...process.env, ...parseEnv(s.env), PORT: String(s.internalPort), HOST: '127.0.0.1', NODE_ENV: 'production' };
  log(s, `Starting app: ${s.startCommand} (PORT=${s.internalPort})`);
  const p = spawn('sh', ['-c', s.startCommand], { cwd: publishDir(s), env, detached: true });
  r.proc = p;
  r.stopping = false;
  const started = Date.now();
  const onData = (b) => { try { fs.appendFileSync(logFile(s), b); } catch (_) {} };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.on('error', (e) => log(s, `App error: ${e.message}`));
  p.on('exit', (code, sig) => {
    if (r.proc === p) r.proc = null;
    const cur = db().sites.find((x) => x.id === s.id);
    if (!cur) return;
    log(cur, `App exited (code ${code}${sig ? ', ' + sig : ''})`);
    if (r.stopping || cur.enabled === false) return;
    if (Date.now() - started > 60000) r.restarts = 0;
    r.restarts = (r.restarts || 0) + 1;
    const delay = Math.min(60, 2 ** r.restarts);
    setStatus(cur, 'error', { lastError: `App crashed (code ${code}), restarting in ${delay}s` });
    r.restartTimer = setTimeout(() => {
      const again = db().sites.find((x) => x.id === s.id);
      if (again && again.enabled !== false && !r.proc) startApp(again).then(() => setStatus(again, 'live', { lastError: '' })).catch(() => {});
    }, delay * 1000);
  });
}

function stopApp(siteId) {
  const r = rt(siteId);
  clearTimeout(r.restartTimer);
  const p = r.proc;
  if (!p) return Promise.resolve();
  r.stopping = true;
  return new Promise((resolve) => {
    const kill = (sig) => { try { process.kill(-p.pid, sig); } catch (_) {} };
    const t = setTimeout(() => kill('SIGKILL'), 5000);
    p.once('exit', () => { clearTimeout(t); r.proc = null; resolve(); });
    kill('SIGTERM');
  });
}

// ---------------------------------------------------------------- serving
function notFound(res, msg = 'Not found') {
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>404</title><body style="font-family:sans-serif;text-align:center;padding:4em;color:#555"><h1>404</h1><p>${msg}</p></body>`);
}

function staticHandler(site) {
  const r = rt(site.id);
  const dir = publishDir(site);
  const key = `${dir}|${site.spa}`;
  if (r.handler && r.handlerKey === key) return r.handler;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(dir, { dotfiles: 'ignore', index: ['index.html', 'index.htm'], redirect: true }));
  app.use((req, res) => {
    if (site.spa && (req.method === 'GET' || req.method === 'HEAD')) {
      const idx = path.join(dir, 'index.html');
      if (fs.existsSync(idx)) return res.sendFile(idx);
    }
    const nf = path.join(dir, '404.html');
    if (fs.existsSync(nf)) return res.status(404).sendFile(nf);
    notFound(res);
  });
  r.handler = app;
  r.handlerKey = key;
  return app;
}

function serveSite(site, req, res) {
  if (site.enabled === false) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    return res.end('This site is currently stopped.');
  }
  if (!fs.existsSync(publishDir(site))) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    return res.end('This site has not been deployed yet.');
  }
  if (site.mode === 'node') {
    if (!site.internalPort) { res.writeHead(503); return res.end('App not started'); }
    return proxy.web(req, res, { target: `http://127.0.0.1:${site.internalPort}` });
  }
  staticHandler(site)(req, res);
}

// Resolve a site for a request on the shared hosting port.
// Order: exact domain -> <slug>.<baseDomain> -> /<slug>/ path prefix
function resolve(req) {
  const d = db();
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const base = (d.settings.sitesBaseDomain || '').toLowerCase();
  for (const s of d.sites) if ((s.domains || []).includes(host)) return { site: s };
  if (base && host.endsWith('.' + base)) {
    const slug = host.slice(0, -(base.length + 1));
    const s = d.sites.find((x) => x.slug === slug);
    if (s) return { site: s };
  }
  const m = (req.url || '').match(/^\/([a-z0-9-]+)(\/.*|\?.*)?$/);
  if (m) {
    const s = d.sites.find((x) => x.slug === m[1]);
    if (s) return { site: s, prefix: '/' + m[1], rest: m[2] || '' };
  }
  return null;
}

function hostingHandler(req, res) {
  const r = resolve(req);
  if (!r) return notFound(res, 'No site is configured for this address.');
  if (r.prefix) {
    if (!r.rest || r.rest.startsWith('?')) {
      res.writeHead(301, { Location: r.prefix + '/' + (r.rest || '') });
      return res.end();
    }
    req.url = r.rest;
    req.headers['x-forwarded-prefix'] = r.prefix;
  }
  serveSite(r.site, req, res);
}

function hostingUpgrade(req, socket, head) {
  const r = resolve(req);
  if (!r || r.site.mode !== 'node' || !r.site.internalPort || r.site.enabled === false) return socket.destroy();
  if (r.prefix) req.url = r.rest || '/';
  proxy.ws(req, socket, head, { target: `http://127.0.0.1:${r.site.internalPort}` });
}

// Ensure each site with a dedicated port has exactly one listener on it.
async function syncDedicatedServers() {
  const d = db();
  for (const [sid, r] of runtime) {
    const s = d.sites.find((x) => x.id === sid);
    if (r.server && (!s || s.port !== r.serverPort)) {
      r.server.close();
      r.server = null;
      r.serverPort = null;
    }
  }
  for (const s of d.sites) {
    if (!s.port) continue;
    const r = rt(s.id);
    if (r.server) continue;
    const srv = http.createServer((req, res) => {
      const cur = db().sites.find((x) => x.id === s.id);
      if (!cur) return notFound(res);
      serveSite(cur, req, res);
    });
    srv.on('upgrade', (req, socket, head) => {
      const cur = db().sites.find((x) => x.id === s.id);
      if (!cur || cur.mode !== 'node' || !cur.internalPort) return socket.destroy();
      proxy.ws(req, socket, head, { target: `http://127.0.0.1:${cur.internalPort}` });
    });
    await new Promise((resolveP) => {
      srv.once('error', (e) => {
        log(s, `Could not listen on port ${s.port}: ${e.message}`);
        setStatus(s, 'error', { lastError: `Port ${s.port}: ${e.message}` });
        resolveP();
      });
      srv.listen(s.port, '0.0.0.0', () => {
        r.server = srv;
        r.serverPort = s.port;
        console.log(`[sites] ${s.slug} listening on dedicated port ${s.port}`);
        resolveP();
      });
    });
  }
}

// ---------------------------------------------------------------- CRUD
async function create(input) {
  const data = await validate(input, null);
  const site = {
    id: id(),
    ...data,
    enabled: true,
    status: 'pending',
    webhookSecret: crypto.randomBytes(16).toString('hex'),
    createdAt: Date.now(),
  };
  if (site.mode === 'node') site.internalPort = await allocInternalPort(site.id);
  db().sites.push(site);
  save();
  await syncDedicatedServers();
  deploy(site.id);
  return site;
}

async function update(siteId, input) {
  const d = db();
  const site = d.sites.find((s) => s.id === siteId);
  if (!site) throw Object.assign(new Error('Site not found'), { status: 404 });
  const data = await validate({ ...site, ...input }, siteId);
  const oldDir = repoDir(site);
  const repoChanged = data.repoUrl !== site.repoUrl || data.branch !== site.branch;
  Object.assign(site, data);
  if (site.mode === 'node' && !site.internalPort) site.internalPort = await allocInternalPort(site.id);
  if (site.mode !== 'node') await stopApp(site.id);
  const newDir = repoDir(site);
  if (oldDir !== newDir && fs.existsSync(oldDir)) {
    await stopApp(site.id);
    fs.rmSync(newDir, { recursive: true, force: true });
    fs.renameSync(oldDir, newDir);
  }
  if (repoChanged) fs.rmSync(newDir, { recursive: true, force: true }); // fresh clone
  rt(site.id).handler = null;
  save();
  await syncDedicatedServers();
  deploy(site.id);
  return site;
}

async function remove(siteId) {
  const d = db();
  const site = d.sites.find((s) => s.id === siteId);
  if (!site) return;
  await stopApp(siteId);
  d.sites = d.sites.filter((s) => s.id !== siteId);
  save();
  await syncDedicatedServers();
  fs.rmSync(repoDir(site), { recursive: true, force: true });
  fs.rmSync(logFile(site), { force: true });
  fs.rmSync(logFile(site) + '.1', { force: true });
  runtime.delete(siteId);
}

async function setEnabled(siteId, enabled) {
  const site = db().sites.find((s) => s.id === siteId);
  if (!site) throw Object.assign(new Error('Site not found'), { status: 404 });
  site.enabled = enabled;
  save();
  if (!enabled) {
    await stopApp(siteId);
    log(site, 'Site stopped');
    setStatus(site, 'stopped');
  } else {
    log(site, 'Site started');
    if (site.mode === 'node' && fs.existsSync(publishDir(site))) {
      await startApp(site);
      setStatus(site, 'live', { lastError: '' });
    } else if (fs.existsSync(publishDir(site))) {
      setStatus(site, 'live', { lastError: '' });
    } else {
      deploy(siteId);
    }
  }
}

function info(site) {
  const r = runtime.get(site.id) || {};
  return {
    ...site,
    webhookSecret: undefined,
    running: site.mode === 'node' ? !!r.proc : undefined,
    deploying: !!r.deploying,
  };
}

// ---------------------------------------------------------------- startup / scheduler
async function startAll() {
  const d = db();
  await syncDedicatedServers();
  for (const s of d.sites) {
    if (s.enabled === false) continue;
    if (!fs.existsSync(path.join(repoDir(s), '.git'))) { deploy(s.id); continue; }
    if (s.mode === 'node') {
      startApp(s).then(() => setStatus(s, 'live')).catch((e) => setStatus(s, 'error', { lastError: e.message }));
    } else if (s.status === 'deploying' || s.status === 'pending') {
      deploy(s.id);
    }
  }
  setInterval(() => {
    const now = Date.now();
    for (const s of db().sites) {
      if (!s.autoPullMinutes || s.enabled === false) continue;
      if (now - (s.lastCheck || 0) >= s.autoPullMinutes * 60000) deploy(s.id, { onlyIfChanged: true });
    }
  }, 60000).unref();
}

async function shutdown() {
  await Promise.all([...runtime.keys()].map((k) => stopApp(k)));
}

module.exports = {
  create, update, remove, deploy, setEnabled, info, readLog, startAll, shutdown,
  hostingHandler, hostingUpgrade, repoDir, slugify,
};
