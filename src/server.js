const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const store = require('./db');
const auth = require('./auth');
const sso = require('./sso');
const sites = require('./sites');
const files = require('./files');
const terminal = require('./terminal');
const cloudflare = require('./cloudflare');
const access = require('./access');
const analytics = require('./analytics');
const nodeVersions = require('./node-versions');

const { db, save, id, encrypt, PERMISSIONS } = store;

// Build id of this image (set by CI). Used to version the UI's script/style URLs so
// browsers and Cloudflare never serve an old app.js after an update.
const BUILD = (process.env.PAGEMASTER_BUILD || 'dev').slice(0, 7);
const ASSET_VERSION = BUILD === 'dev' ? Date.now().toString(36) : BUILD;
store.load();
auth.ensureDefaultAdmin();
store.load(); // re-run migrations now that an admin exists (assigns site owners)
analytics.start();

const app = express();
app.disable('x-powered-by');
if (config.TRUST_PROXY) app.set('trust proxy', true);
app.use(cookieParser());
app.use(auth.attachUser);
app.use((req, res, next) => {
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const json = express.json({ limit: '1mb' });

// ------------------------------------------------------------------ webhooks (no login, secret in URL)
app.post('/hooks/:id/:secret', (req, res) => {
  const site = db().sites.find((s) => s.id === req.params.id);
  const ok = site && site.webhookSecret && req.params.secret.length === site.webhookSecret.length &&
    crypto.timingSafeEqual(Buffer.from(req.params.secret), Buffer.from(site.webhookSecret));
  if (!ok) return res.status(404).json({ error: 'Not found' });
  sites.deploy(site.id);
  res.json({ ok: true, message: 'Deploy started' });
});

// ------------------------------------------------------------------ auth
sso.register(app);

// Sign-in handover for private websites (see sites.js "private sites")
function plainPage(res, status, title, text) {
  res.status(status).set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:4em 1em;color:#555"><h1>${title}</h1><p>${text}</p><p><a href="/">Open Pagemaster</a></p></body>`);
}
app.get('/auth/site', (req, res) => {
  const site = db().sites.find((s) => s.id === req.query.site);
  if (!site) return plainPage(res, 404, 'Site not found', 'This site no longer exists.');
  let cb;
  try { cb = new URL(String(req.query.cb || '')); } catch (_) { cb = null; }
  const okPath = cb && (cb.pathname === sites.AUTH_PATH || cb.pathname === `/${site.slug}${sites.AUTH_PATH}`);
  if (!cb || !/^https?:$/.test(cb.protocol) || !okPath || !sites.trustedHosts(site, req).has(cb.hostname.toLowerCase())) {
    return plainPage(res, 400, 'Unknown address', 'Pagemaster does not know this address for the site. Open the site through one of its own addresses.');
  }
  if (!req.user) return res.redirect('/?next=' + encodeURIComponent(req.originalUrl));
  if (!access.siteCan(req.user, site, 'view')) {
    return plainPage(res, 403, 'No access', `You are signed in as <b>${req.user.username.replace(/[<>&"]/g, '')}</b>, but "${site.name.replace(/[<>&"]/g, '')}" is private and hasn't been shared with you.`);
  }
  cb.searchParams.set('t', sites.makeTicket(site.id, req.user.id, auth.sessionKey(req)));
  res.set('Cache-Control', 'no-store').redirect(cb.toString());
});
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api', auth.csrfGuard);

app.get('/api/public', (_req, res) => {
  const s = db().settings.sso;
  res.json({ sso: { enabled: !!(s.enabled && s.issuer && s.clientId), label: s.label || 'Sign in with SSO' } });
});

app.post('/api/login', json, (req, res) => {
  const ip = req.ip;
  if (auth.rateLimited(ip)) return res.status(429).json({ error: 'Too many attempts, wait 15 minutes' });
  const u = auth.verifyLocal(req.body.username, req.body.password);
  if (!u) { auth.recordFail(ip); return res.status(401).json({ error: 'Invalid username or password' }); }
  auth.clearFails(ip);
  auth.createSession(res, u);
  res.json({ user: auth.publicUser(u) });
});

app.post('/api/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

app.get('/api/me', auth.requireAuth, (req, res) => {
  res.json({
    user: auth.publicUser(req.user),
    permissions: PERMISSIONS,
    sitePermissions: access.SITE_PERMS,
    // Access through per-site sharing (on top of the global permissions)
    siteAccess: { view: access.anySite(req.user, 'view'), files: access.anySite(req.user, 'files.read'), passwords: access.anySite(req.user, 'passwords.view') },
    ssoEnabled: sso.enabled(),
  });
});

// Link the signed-in account to an SSO identity: returns the provider URL to go to
app.post('/api/account/sso/link', auth.requireAuth, wrap(async (req, res) => {
  if (!sso.enabled()) return res.status(400).json({ error: 'SSO is not enabled in Settings' });
  res.json({ url: await sso.authorizationUrl(req, req.user.id) });
}));
app.post('/api/account/sso/unlink', auth.requireAuth, (req, res) => {
  const u = req.user;
  if (!u.ssoSubject) return res.status(400).json({ error: 'No SSO account is linked' });
  if (!u.passwordHash) return res.status(400).json({ error: 'This account has no password, so unlinking SSO would lock you out' });
  u.ssoSubject = null;
  u.ssoName = '';
  save();
  res.json({ user: auth.publicUser(u) });
});

app.post('/api/account/password', auth.requireAuth, json, (req, res) => {
  const u = req.user;
  if (u.source !== 'local' && !u.passwordHash) return res.status(400).json({ error: 'SSO accounts have no local password' });
  if (!auth.verifyLocal(u.username, req.body.current)) return res.status(400).json({ error: 'Current password is wrong' });
  const err = auth.validatePassword(req.body.password);
  if (err) return res.status(400).json({ error: err });
  u.passwordHash = auth.hashPassword(req.body.password);
  u.mustChangePassword = false;
  save();
  auth.destroyUserSessions(u.id, req.cookies[auth.COOKIE]);
  res.json({ ok: true });
});

app.post('/api/account/username', auth.requireAuth, json, (req, res) => {
  const name = String(req.body.username || '').trim();
  if (!/^[a-zA-Z0-9_.@-]{2,64}$/.test(name)) return res.status(400).json({ error: 'Username: 2-64 letters, numbers, _ . @ -' });
  if (db().users.some((x) => x.id !== req.user.id && x.username.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'Username taken' });
  req.user.username = name;
  save();
  res.json({ ok: true });
});

// ------------------------------------------------------------------ system info
app.get('/api/system', auth.requireAuth, (_req, res) => {
  const d = db();
  res.json({
    adminPort: config.ADMIN_PORT,
    hostingPort: config.HOSTING_PORT,
    hostingPublicPort: config.HOSTING_PUBLIC_PORT,
    sitesUrl: d.settings.sitesUrl || '',
    publicUrl: d.settings.publicUrl || '',
    sitePortRange: config.SITE_PORT_RANGE,
    usedPorts: d.sites.filter((s) => s.port).map((s) => ({ port: s.port, site: s.name })),
    sitesBaseDomain: d.settings.sitesBaseDomain || '',
    storage: { ...sites.getStorageCheck(), fix: sites.STORAGE_FIX },
    version: require('../package.json').version,
    build: BUILD,
  });
});

// ------------------------------------------------------------------ sites
const P = auth.requirePerm;
function userName(uid) {
  const u = db().users.find((x) => x.id === uid);
  return u ? u.username : '(deleted user)';
}
function siteOut(req, s) {
  const o = sites.info(s);
  const my = access.myAccess(req.user, s);
  o.my = my;
  o.ownerName = userName(s.ownerId);
  delete o.members;
  if (my.manage) {
    const base = (db().settings.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    o.webhookUrl = `${base}/hooks/${s.id}/${s.webhookSecret}`;
  } else {
    delete o.env; // may hold secrets
  }
  if (my.share) o.members = (s.members || []).map((m) => ({ userId: m.userId, username: userName(m.userId), perms: m.perms }));
  return o;
}
// Middleware: loads the site into req.site and checks a per-site permission
function S(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in' });
    const s = db().sites.find((x) => x.id === req.params.id);
    if (!s || !access.siteCan(req.user, s, 'view')) return res.status(404).json({ error: 'Site not found' });
    const ok = perm === 'share' ? access.canShare(req.user, s)
      : perm === 'transfer' ? access.canTransfer(req.user, s)
        : access.siteCan(req.user, s, perm);
    if (!ok) return res.status(403).json({ error: `You don't have "${perm}" access to this site` });
    req.site = s;
    next();
  };
}

app.get('/api/sites', auth.requireAuth, (req, res) => res.json(access.visibleSites(req.user).map((s) => siteOut(req, s))));
app.post('/api/sites', P('sites.manage'), json, wrap(async (req, res) => res.json(siteOut(req, await sites.create(req.body, req.user.id)))));
app.put('/api/sites/:id', S('manage'), json, wrap(async (req, res) => {
  res.json(siteOut(req, await sites.update(req.params.id, req.body)));
}));
app.delete('/api/sites/:id', S('share'), wrap(async (req, res) => {
  await cloudflare.removeSiteRoutes(req.params.id);
  await sites.remove(req.params.id);
  res.json({ ok: true });
}));
app.post('/api/sites/:id/deploy', S('deploy'), (req, res) => {
  if (req.site.status === 'waiting') { req.site.status = 'pending'; save(); }
  sites.deploy(req.params.id);
  res.json({ ok: true });
});
app.post('/api/sites/:id/start', S('deploy'), wrap(async (req, res) => {
  await sites.setEnabled(req.params.id, true);
  res.json({ ok: true });
}));
app.post('/api/sites/:id/stop', S('deploy'), wrap(async (req, res) => {
  await sites.setEnabled(req.params.id, false);
  res.json({ ok: true });
}));
app.post('/api/sites/:id/webhook/rotate', S('manage'), (req, res) => {
  req.site.webhookSecret = crypto.randomBytes(16).toString('hex');
  save();
  res.json(siteOut(req, req.site));
});
app.get('/api/sites/:id/log', S('view'), (req, res) => {
  res.type('text/plain').send(sites.readLog(req.site));
});
app.delete('/api/sites/:id/log', S('deploy'), (req, res) => {
  sites.clearLog(req.site);
  res.json({ ok: true });
});

// Node.js versions a site can pick
app.get('/api/node-versions', auth.requireAuth, wrap(async (_req, res) => res.json(await nodeVersions.available())));

// Notes (one shared text per site)
app.put('/api/sites/:id/notes', S('notes.edit'), json, (req, res) => {
  const text = String(req.body.text || '');
  if (text.length > 100000) return res.status(400).json({ error: 'Notes are limited to 100,000 characters' });
  req.site.notes = { text, updatedBy: req.user.username, updatedAt: Date.now() };
  save();
  res.json(siteOut(req, req.site));
});

// Password vault (per site). Passwords are stored encrypted and only sent when
// someone with passwords.view asks for one.
function vaultOut(e) {
  return { id: e.id, title: e.title, username: e.username, url: e.url, notes: e.notes, hasPassword: !!e.password, updatedBy: e.updatedBy, updatedAt: e.updatedAt };
}
function vaultInput(b, existing = {}) {
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) throw Object.assign(new Error('Give the entry a name'), { status: 400 });
  const out = {
    title,
    username: String(b.username || '').slice(0, 300),
    url: String(b.url || '').trim().slice(0, 500),
    notes: String(b.notes || '').slice(0, 5000),
  };
  if (b.password !== undefined && b.password !== null && (b.password !== '' || !existing.password)) out.password = b.password === '' ? '' : encrypt(String(b.password).slice(0, 1000));
  return out;
}
app.get('/api/vault', auth.requireAuth, (req, res) => {
  res.json(db().sites.filter((s) => access.siteCan(req.user, s, 'passwords.view')).map((s) => ({
    siteId: s.id, siteName: s.name, slug: s.slug, canEdit: access.siteCan(req.user, s, 'passwords.edit'), entries: (s.vault || []).map(vaultOut),
  })));
});
app.get('/api/sites/:id/vault', S('passwords.view'), (req, res) => {
  res.json({ canEdit: access.siteCan(req.user, req.site, 'passwords.edit'), entries: (req.site.vault || []).map(vaultOut) });
});
app.post('/api/sites/:id/vault', S('passwords.edit'), json, (req, res) => {
  const e = { id: id(), ...vaultInput(req.body), updatedBy: req.user.username, updatedAt: Date.now() };
  req.site.vault = [...(req.site.vault || []), e];
  save();
  res.json(vaultOut(e));
});
app.put('/api/sites/:id/vault/:eid', S('passwords.edit'), json, (req, res) => {
  const e = (req.site.vault || []).find((x) => x.id === req.params.eid);
  if (!e) return res.status(404).json({ error: 'Entry not found' });
  Object.assign(e, vaultInput(req.body, e), { updatedBy: req.user.username, updatedAt: Date.now() });
  save();
  res.json(vaultOut(e));
});
app.delete('/api/sites/:id/vault/:eid', S('passwords.edit'), (req, res) => {
  req.site.vault = (req.site.vault || []).filter((x) => x.id !== req.params.eid);
  save();
  res.json({ ok: true });
});
app.post('/api/sites/:id/vault/:eid/reveal', S('passwords.view'), (req, res) => {
  const e = (req.site.vault || []).find((x) => x.id === req.params.eid);
  if (!e) return res.status(404).json({ error: 'Entry not found' });
  console.log(`[vault] ${req.user.username} viewed "${e.title}" of site "${req.site.name}"`);
  res.json({ password: e.password ? store.decrypt(e.password) : '' });
});

// Website / panel visibility
app.put('/api/sites/:id/visibility', S('manage'), json, (req, res) => {
  const b = req.body || {};
  // Making a site visible to every user is a sharing decision
  if (b.panelVisibility !== undefined && b.panelVisibility !== req.site.panelVisibility && !access.canShare(req.user, req.site)) {
    return res.status(403).json({ error: 'Only the owner or an admin can change who sees this site in Pagemaster' });
  }
  res.json(siteOut(req, sites.setVisibility(req.params.id, b)));
});

// Per-site SSH deploy key
app.get('/api/sites/:id/deploy-key', S('manage'), (req, res) => {
  res.json({ publicKey: sites.ensureSiteKey(req.site), inUse: req.site.credentialId === 'deploykey' });
});
app.post('/api/sites/:id/deploy-key/regenerate', S('manage'), (req, res) => {
  res.json({ publicKey: sites.ensureSiteKey(req.site, true), inUse: req.site.credentialId === 'deploykey' });
});

// Primary address (+ optional redirect of the other addresses to it)
app.put('/api/sites/:id/primary', S('manage'), json, (req, res) => {
  res.json(siteOut(req, sites.setPrimary(req.params.id, req.body || {})));
});

// Analytics
app.get('/api/sites/:id/analytics', S('view'), (req, res) => {
  res.json(analytics.summary(req.site.id, req.query.days));
});
app.delete('/api/sites/:id/analytics', S('manage'), (req, res) => {
  analytics.reset(req.site.id);
  res.json({ ok: true });
});

// Per-site sharing
app.put('/api/sites/:id/members', S('share'), json, (req, res) => {
  const d = db();
  const list = Array.isArray(req.body.members) ? req.body.members : [];
  const out = new Map();
  for (const m of list) {
    const u = d.users.find((x) => x.id === m.userId);
    if (!u) return res.status(400).json({ error: 'Unknown user in the list' });
    if (u.id === req.site.ownerId) continue; // the owner already has full access
    const perms = access.cleanSitePerms(m.perms);
    if (perms.length) out.set(u.id, { userId: u.id, perms });
  }
  req.site.members = [...out.values()];
  save();
  res.json(siteOut(req, req.site));
});

// Ownership transfer
app.post('/api/sites/:id/transfer', S('transfer'), json, (req, res) => {
  const d = db();
  const site = req.site;
  const to = d.users.find((x) => x.id === req.body.userId);
  if (!to || to.disabled) return res.status(400).json({ error: 'Choose an active user' });
  if (to.id === site.ownerId) return res.status(400).json({ error: `${to.username} already owns this site` });
  const prev = site.ownerId;
  site.ownerId = to.id;
  site.members = (site.members || []).filter((m) => m.userId !== to.id);
  if (req.body.keepAccess && prev && d.users.some((u) => u.id === prev)) {
    site.members.push({ userId: prev, perms: Object.keys(access.SITE_PERMS) });
  }
  save();
  console.log(`[sites] ${req.user.username} transferred "${site.name}" from ${userName(prev)} to ${to.username}`);
  res.json(siteOut(req, site));
});

// ------------------------------------------------------------------ git credentials
const HOST_DEFAULT_USER = {
  'github.com': 'x-access-token',
  'gitlab.com': 'oauth2',
  'bitbucket.org': 'x-token-auth',
};
function credOut(c) {
  return { id: c.id, name: c.name, host: c.host, username: c.username, hasToken: !!c.token, createdAt: c.createdAt };
}
app.get('/api/credentials/options', P('sites.manage'), (_req, res) => {
  res.json(db().credentials.map((c) => ({ id: c.id, name: c.name, host: c.host })));
});
app.get('/api/credentials', P('credentials.manage'), (_req, res) => res.json(db().credentials.map(credOut)));
function credInput(body, existing = {}) {
  const name = String(body.name || '').trim();
  const host = String(body.host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!name) throw Object.assign(new Error('Name is required'), { status: 400 });
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) throw Object.assign(new Error('Host must look like github.com or git.example.com'), { status: 400 });
  const username = String(body.username || '').trim() || HOST_DEFAULT_USER[host] || 'git';
  const out = { name, host, username };
  if (body.token) out.token = encrypt(String(body.token).trim());
  else if (!existing.token) throw Object.assign(new Error('Token is required'), { status: 400 });
  return out;
}
app.post('/api/credentials', P('credentials.manage'), json, (req, res) => {
  const c = { id: id(), ...credInput(req.body), createdAt: Date.now() };
  db().credentials.push(c);
  save();
  res.json(credOut(c));
});
app.put('/api/credentials/:id', P('credentials.manage'), json, (req, res) => {
  const c = db().credentials.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  Object.assign(c, credInput(req.body, c));
  save();
  res.json(credOut(c));
});
app.delete('/api/credentials/:id', P('credentials.manage'), (req, res) => {
  const d = db();
  d.credentials = d.credentials.filter((x) => x.id !== req.params.id);
  for (const s of d.sites) if (s.credentialId === req.params.id) s.credentialId = 'auto';
  save();
  res.json({ ok: true });
});

// SSH deploy key (for git@... / ssh:// repos on any host)
const SSH_KEY = path.join(config.SSH_DIR, 'id_ed25519');
app.get('/api/ssh', P('credentials.manage'), (_req, res) => {
  const pub = SSH_KEY + '.pub';
  res.json({ publicKey: fs.existsSync(pub) ? fs.readFileSync(pub, 'utf8').trim() : '' });
});
app.post('/api/ssh/generate', P('credentials.manage'), (_req, res) => {
  fs.rmSync(SSH_KEY, { force: true });
  fs.rmSync(SSH_KEY + '.pub', { force: true });
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'pagemaster', '-f', SSH_KEY]);
  res.json({ publicKey: fs.readFileSync(SSH_KEY + '.pub', 'utf8').trim() });
});

// ------------------------------------------------------------------ users
function cleanPerms(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((p) => PERMISSIONS[p]))];
}
// Non-admin user managers can only hand out permissions they hold themselves
function grantable(req, list) {
  const perms = cleanPerms(list);
  return req.user.isAdmin ? perms : perms.filter((p) => auth.can(req.user, p));
}
const isPriv = (u) => !!(u.isAdmin || u.isLimitedAdmin);
// Who may change this account at all? Admin accounts need a full admin; the main
// owner can only be changed by themselves.
function guardTarget(req, u, wantsPriv = false) {
  if (u.isOwner && u.id !== req.user.id) return 'Only the main owner can change the main owner account';
  if ((isPriv(u) || wantsPriv) && !req.user.isAdmin && u.id !== req.user.id) return 'Only admins can change admin accounts';
  if (wantsPriv && !req.user.isAdmin) return 'Only admins can make admins';
  return null;
}
function adminCount() {
  return db().users.filter((u) => u.isAdmin && !u.disabled).length;
}
app.get('/api/users', P('users.manage'), (_req, res) => res.json(db().users.map(auth.publicUser)));
// Minimal list of active users, for picking someone to share a site with or transfer it to
app.get('/api/users/directory', auth.requireAuth, (_req, res) => {
  res.json(db().users.filter((u) => !u.disabled).map((u) => ({ id: u.id, username: u.username, displayName: u.displayName || '', canTunnel: auth.can(u, 'tunnels.manage') })));
});

// Move everything a user owns or has access to over to another user
function handOver(fromId, toId) {
  const d = db();
  for (const s of d.sites) {
    if (s.ownerId === fromId) s.ownerId = toId;
    const fromM = (s.members || []).find((m) => m.userId === fromId);
    s.members = (s.members || []).filter((m) => m.userId !== fromId && m.userId !== s.ownerId);
    if (fromM && toId && s.ownerId !== toId) {
      const toM = s.members.find((m) => m.userId === toId);
      if (toM) toM.perms = access.cleanSitePerms([...toM.perms, ...fromM.perms]);
      else s.members.push({ userId: toId, perms: fromM.perms });
    }
  }
}

// Admin: merge an SSO user (e.g. one auto-created on first SSO login) into this account,
// so the account can sign in with that SSO identity.
app.post('/api/users/:id/link-sso', P('users.manage'), json, (req, res) => {
  if (!req.user.isAdmin) return res.status(403).json({ error: 'Only admins can link accounts' });
  const d = db();
  const target = d.users.find((x) => x.id === req.params.id);
  const from = d.users.find((x) => x.id === req.body.fromUserId);
  if (!target || !from) return res.status(404).json({ error: 'User not found' });
  const g = guardTarget(req, target) || guardTarget(req, from);
  if (g) return res.status(403).json({ error: g });
  if (target.id === from.id) return res.status(400).json({ error: 'Pick a different user' });
  if (!from.ssoSubject) return res.status(400).json({ error: `${from.username} has no SSO identity` });
  if (from.id === req.user.id) return res.status(400).json({ error: 'You cannot merge away the account you are signed in with' });
  target.ssoSubject = from.ssoSubject;
  target.ssoName = from.ssoName || from.username;
  if (!target.email && from.email) target.email = from.email;
  if (!target.displayName && from.displayName) target.displayName = from.displayName;
  if (!target.isAdmin) {
    target.isAdmin = !!from.isAdmin;
    target.isLimitedAdmin = !target.isAdmin && !!(target.isLimitedAdmin || from.isLimitedAdmin);
    target.permissions = cleanPerms([...(target.permissions || []), ...(from.permissions || [])]);
  }
  handOver(from.id, target.id);
  for (const t of d.tunnels) if (t.userId === from.id) t.userId = target.id;
  d.users = d.users.filter((x) => x.id !== from.id);
  auth.destroyUserSessions(from.id);
  save();
  console.log(`[users] ${req.user.username} merged SSO user ${from.username} into ${target.username}`);
  res.json(auth.publicUser(target));
});
app.post('/api/users', P('users.manage'), json, (req, res) => {
  const d = db();
  const username = String(req.body.username || '').trim();
  if (!/^[a-zA-Z0-9_.@-]{2,64}$/.test(username)) return res.status(400).json({ error: 'Username: 2-64 letters, numbers, _ . @ -' });
  if (d.users.some((x) => x.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'Username taken' });
  const err = auth.validatePassword(req.body.password);
  if (err) return res.status(400).json({ error: err });
  if ((req.body.isAdmin || req.body.isLimitedAdmin) && !req.user.isAdmin) return res.status(403).json({ error: 'Only admins can create admins' });
  const u = {
    id: id(),
    username,
    passwordHash: auth.hashPassword(req.body.password),
    source: 'local',
    isAdmin: !!req.body.isAdmin,
    isLimitedAdmin: !req.body.isAdmin && !!req.body.isLimitedAdmin,
    permissions: grantable(req, req.body.permissions),
    mustChangePassword: !!req.body.mustChangePassword,
    disabled: false,
    createdAt: Date.now(),
  };
  d.users.push(u);
  save();
  res.json(auth.publicUser(u));
});
app.put('/api/users/:id', P('users.manage'), json, (req, res) => {
  const d = db();
  const u = d.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const wantsPriv = (!!req.body.isAdmin && !u.isAdmin) || (!!req.body.isLimitedAdmin && !u.isLimitedAdmin);
  const g = guardTarget(req, u, wantsPriv);
  if (g) return res.status(403).json({ error: g });
  const demote = (req.body.isAdmin === false && u.isAdmin) || (req.body.isLimitedAdmin === false && u.isLimitedAdmin && !req.body.isAdmin);
  if (u.id === req.user.id && (demote || req.body.disabled)) {
    return res.status(400).json({ error: 'You cannot remove your own admin rights or disable yourself' });
  }
  if (u.isOwner && (req.body.isAdmin === false || req.body.disabled)) {
    return res.status(400).json({ error: 'Make someone else the main owner first' });
  }
  if (u.isAdmin && (req.body.isAdmin === false || req.body.disabled) && adminCount() <= 1) {
    return res.status(400).json({ error: 'At least one active admin is required' });
  }
  if (req.body.username !== undefined) {
    const name = String(req.body.username).trim();
    if (!/^[a-zA-Z0-9_.@-]{2,64}$/.test(name)) return res.status(400).json({ error: 'Invalid username' });
    if (d.users.some((x) => x.id !== u.id && x.username.toLowerCase() === name.toLowerCase())) return res.status(409).json({ error: 'Username taken' });
    u.username = name;
  }
  if (req.body.permissions !== undefined) u.permissions = grantable(req, req.body.permissions);
  if (req.body.isAdmin !== undefined && req.user.isAdmin) u.isAdmin = !!req.body.isAdmin;
  if (req.body.isLimitedAdmin !== undefined && req.user.isAdmin) u.isLimitedAdmin = !u.isAdmin && !!req.body.isLimitedAdmin;
  if (u.isAdmin) u.isLimitedAdmin = false;
  if (req.body.disabled !== undefined) u.disabled = !!req.body.disabled;
  if (req.body.unlinkSso && u.ssoSubject) {
    if (!u.passwordHash) return res.status(400).json({ error: 'This account has no password; unlinking SSO would lock it out. Delete it instead.' });
    u.ssoSubject = null;
    u.ssoName = '';
  }
  if (req.body.password) {
    const err = auth.validatePassword(req.body.password);
    if (err) return res.status(400).json({ error: err });
    u.passwordHash = auth.hashPassword(req.body.password);
    u.mustChangePassword = !!req.body.mustChangePassword;
    auth.destroyUserSessions(u.id);
  }
  if (u.disabled) auth.destroyUserSessions(u.id);
  save();
  res.json(auth.publicUser(u));
});
app.delete('/api/users/:id', P('users.manage'), wrap(async (req, res) => {
  const d = db();
  const u = d.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  if (u.isOwner) return res.status(400).json({ error: 'The main owner cannot be deleted. Make someone else the main owner first.' });
  if (isPriv(u) && !req.user.isAdmin) return res.status(403).json({ error: 'Only admins can delete admins' });
  if (u.isAdmin && adminCount() <= 1) return res.status(400).json({ error: 'At least one active admin is required' });
  await cloudflare.removeUserTunnels(u.id);
  handOver(u.id, req.user.id); // their sites now belong to whoever deleted them
  d.users = d.users.filter((x) => x.id !== u.id);
  auth.destroyUserSessions(u.id);
  save();
  res.json({ ok: true });
}));

// Hand the main owner role to another full admin
app.post('/api/users/:id/make-owner', auth.requireAuth, (req, res) => {
  if (!req.user.isOwner) return res.status(403).json({ error: 'Only the main owner can do this' });
  const u = db().users.find((x) => x.id === req.params.id);
  if (!u || u.disabled || !u.isAdmin) return res.status(400).json({ error: 'The new main owner must be an active full admin' });
  req.user.isOwner = false;
  u.isOwner = true;
  save();
  res.json(auth.publicUser(u));
});

// ------------------------------------------------------------------ settings
function settingsOut(req) {
  const s = db().settings;
  return {
    publicUrl: s.publicUrl,
    sitesUrl: s.sitesUrl || '',
    sitesBaseDomain: s.sitesBaseDomain,
    sso: { ...s.sso, clientSecret: undefined, hasClientSecret: !!s.sso.clientSecret },
    ssoRedirectUri: sso.redirectUri(req),
  };
}
app.get('/api/settings', P('settings.manage'), (req, res) => res.json(settingsOut(req)));
app.put('/api/settings', P('settings.manage'), json, (req, res) => {
  const s = db().settings;
  const b = req.body || {};
  if (b.publicUrl !== undefined) {
    const u = String(b.publicUrl).trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\/[^\s/]+$/.test(u)) return res.status(400).json({ error: 'Public URL must be like https://pagemaster.example.com' });
    s.publicUrl = u;
  }
  if (b.sitesUrl !== undefined) {
    const u = String(b.sitesUrl).trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\/[^\s/]+$/.test(u)) return res.status(400).json({ error: 'Sites URL must be like http://192.168.1.50 or https://sites.example.com (no path)' });
    s.sitesUrl = u;
  }
  if (b.sitesBaseDomain !== undefined) {
    const dmn = String(b.sitesBaseDomain).trim().toLowerCase().replace(/^\*?\./, '');
    if (dmn && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dmn)) return res.status(400).json({ error: 'Invalid base domain' });
    // Make sure this doesn't create a hostname collision between sites
    const hosts = new Map();
    for (const site of db().sites) {
      for (const h of [...(site.domains || []), ...(dmn ? [`${site.slug}.${dmn}`] : [])]) {
        if (hosts.has(h) && hosts.get(h) !== site.id) return res.status(400).json({ error: `Base domain would make ${h} point to two sites` });
        hosts.set(h, site.id);
      }
    }
    for (const t of db().tunnels) {
      for (const r of t.routes || []) {
        if (hosts.has(r.hostname) && hosts.get(r.hostname) !== r.siteId) return res.status(400).json({ error: `Base domain clashes with tunnel hostname ${r.hostname}` });
      }
    }
    s.sitesBaseDomain = dmn;
  }
  if (b.sso) {
    const x = b.sso;
    s.sso.enabled = !!x.enabled;
    s.sso.label = String(x.label || 'Sign in with SSO').slice(0, 60);
    s.sso.issuer = String(x.issuer || '').trim();
    s.sso.clientId = String(x.clientId || '').trim();
    if (x.clientSecret) s.sso.clientSecret = String(x.clientSecret).trim();
    if (x.clearClientSecret) s.sso.clientSecret = '';
    s.sso.scopes = String(x.scopes || 'openid profile email').trim();
    s.sso.autoCreate = !!x.autoCreate;
    s.sso.defaultPermissions = cleanPerms(x.defaultPermissions);
    if (s.sso.enabled && (!/^https?:\/\//.test(s.sso.issuer) || !s.sso.clientId)) {
      return res.status(400).json({ error: 'SSO needs an issuer URL and client ID' });
    }
    sso.resetClient();
  }
  save();
  res.json(settingsOut(req));
});

// ------------------------------------------------------------------ cloudflare tunnels (per user)
const T = P('tunnels.manage');
app.post('/api/cloudflare/inspect', T, json, wrap(async (req, res) => res.json(await cloudflare.inspectToken(String(req.body.apiToken || '').trim()))));
app.get('/api/tunnels', T, (req, res) => res.json(cloudflare.list(req.user)));
app.get('/api/tunnels/sites', T, (req, res) => res.json(db().sites.filter((s) => access.siteCan(req.user, s, 'manage')).map((s) => ({ id: s.id, name: s.name, slug: s.slug }))));
app.post('/api/tunnels', T, json, wrap(async (req, res) => res.json(await cloudflare.create(req.user, req.body))));
app.delete('/api/tunnels/:id', T, wrap(async (req, res) => res.json(await cloudflare.remove(req.user, req.params.id))));
app.post('/api/tunnels/:id/start', T, wrap(async (req, res) => res.json(await cloudflare.setEnabled(req.user, req.params.id, true))));
app.post('/api/tunnels/:id/stop', T, wrap(async (req, res) => res.json(await cloudflare.setEnabled(req.user, req.params.id, false))));
app.get('/api/tunnels/:id/zones', T, wrap(async (req, res) => {
  const t = cloudflare.get(req.user, req.params.id);
  if (t.mode !== 'api') return res.json([]);
  res.json(await cloudflare.listZones(t));
}));
app.put('/api/tunnels/:id/token', T, json, wrap(async (req, res) => res.json(await cloudflare.updateToken(req.user, req.params.id, req.body.apiToken))));
app.post('/api/tunnels/:id/routes', T, json, wrap(async (req, res) => {
  const site = db().sites.find((s) => s.id === req.body.siteId);
  if (site && !access.siteCan(req.user, site, 'manage')) return res.status(403).json({ error: 'You need "manage" access to a site to publish it' });
  res.json(await cloudflare.addRoute(req.user, req.params.id, req.body));
}));
app.post('/api/tunnels/:id/transfer', T, json, (req, res) => {
  const t = cloudflare.get(req.user, req.params.id);
  const to = db().users.find((u) => u.id === req.body.userId);
  if (!to || to.disabled) return res.status(400).json({ error: 'Choose an active user' });
  if (!auth.can(to, 'tunnels.manage')) return res.status(400).json({ error: `${to.username} needs the tunnels.manage permission first` });
  t.userId = to.id;
  save();
  res.json({ ok: true });
});
app.delete('/api/tunnels/:id/routes/:rid', T, wrap(async (req, res) => res.json(await cloudflare.removeRoute(req.user, req.params.id, req.params.rid))));
app.delete('/api/tunnels/:id/log', T, (req, res) => { cloudflare.clearLog(req.user, req.params.id); res.json({ ok: true }); });
app.get('/api/tunnels/:id/log', T, (req, res) => res.type('text/plain').send(cloudflare.readLog(req.user, req.params.id)));

// ------------------------------------------------------------------ files
app.use('/api/files', files.router());

// ------------------------------------------------------------------ static UI
// The page itself is never cached; it points at versioned asset URLs (?v=<build>).
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').replace(/__V__/g, ASSET_VERSION);
app.get(['/', '/index.html'], (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(INDEX_HTML);
});
const assetHeaders = { setHeaders: (res) => res.set('Cache-Control', 'no-cache') };
app.use('/vendor/xterm', express.static(path.join(path.dirname(require.resolve('@xterm/xterm/package.json'))), assetHeaders));
app.use('/vendor/xterm-fit', express.static(path.join(path.dirname(require.resolve('@xterm/addon-fit/package.json'))), assetHeaders));
app.use(express.static(path.join(__dirname, '..', 'public'), { ...assetHeaders, index: false }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || (err.code === 'ENOENT' ? 404 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
});

// ------------------------------------------------------------------ start
const adminServer = http.createServer(app);
terminal.attach(adminServer);
adminServer.listen(config.ADMIN_PORT, '0.0.0.0', () => console.log(`[pagemaster] Admin UI on port ${config.ADMIN_PORT}`));

const hostingServer = http.createServer(sites.hostingHandler);
hostingServer.on('upgrade', sites.hostingUpgrade);
hostingServer.listen(config.HOSTING_PORT, '0.0.0.0', () => console.log(`[pagemaster] Shared site hosting on port ${config.HOSTING_PORT}`));

sites.startAll().catch((e) => console.error('[sites] startup error', e));
cloudflare.startAll();

async function stop() {
  console.log('[pagemaster] shutting down');
  analytics.flush();
  await Promise.all([sites.shutdown(), cloudflare.shutdown()]);
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
