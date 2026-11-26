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

const { db, save, id, encrypt, PERMISSIONS } = store;
store.load();
auth.ensureDefaultAdmin();

const app = express();
app.disable('x-powered-by');
if (config.TRUST_PROXY) app.set('trust proxy', true);
app.use(cookieParser());
app.use(auth.attachUser);
app.use((req, res, next) => {
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
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
  res.json({ user: auth.publicUser(req.user), permissions: PERMISSIONS });
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
    sitePortRange: config.SITE_PORT_RANGE,
    usedPorts: d.sites.filter((s) => s.port).map((s) => ({ port: s.port, site: s.name })),
    sitesBaseDomain: d.settings.sitesBaseDomain || '',
    storage: { ...sites.getStorageCheck(), fix: sites.STORAGE_FIX },
    version: require('../package.json').version,
  });
});

// ------------------------------------------------------------------ sites
const P = auth.requirePerm;
function siteOut(req, s) {
  const o = sites.info(s);
  if (auth.can(req.user, 'sites.manage')) {
    const base = (db().settings.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    o.webhookUrl = `${base}/hooks/${s.id}/${s.webhookSecret}`;
  }
  return o;
}
function findSite(req) {
  const s = db().sites.find((x) => x.id === req.params.id);
  if (!s) throw Object.assign(new Error('Site not found'), { status: 404 });
  return s;
}

app.get('/api/sites', P('sites.view'), (req, res) => res.json(db().sites.map((s) => siteOut(req, s))));
app.post('/api/sites', P('sites.manage'), json, wrap(async (req, res) => res.json(siteOut(req, await sites.create(req.body)))));
app.put('/api/sites/:id', P('sites.manage'), json, wrap(async (req, res) => {
  findSite(req);
  res.json(siteOut(req, await sites.update(req.params.id, req.body)));
}));
app.delete('/api/sites/:id', P('sites.manage'), wrap(async (req, res) => {
  findSite(req);
  await sites.remove(req.params.id);
  res.json({ ok: true });
}));
app.post('/api/sites/:id/deploy', P('sites.deploy'), (req, res) => {
  findSite(req);
  sites.deploy(req.params.id);
  res.json({ ok: true });
});
app.post('/api/sites/:id/start', P('sites.deploy'), wrap(async (req, res) => {
  findSite(req);
  await sites.setEnabled(req.params.id, true);
  res.json({ ok: true });
}));
app.post('/api/sites/:id/stop', P('sites.deploy'), wrap(async (req, res) => {
  findSite(req);
  await sites.setEnabled(req.params.id, false);
  res.json({ ok: true });
}));
app.post('/api/sites/:id/webhook/rotate', P('sites.manage'), (req, res) => {
  const s = findSite(req);
  s.webhookSecret = crypto.randomBytes(16).toString('hex');
  save();
  res.json(siteOut(req, s));
});
app.get('/api/sites/:id/log', P('sites.view'), (req, res) => {
  res.type('text/plain').send(sites.readLog(findSite(req)));
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
function adminCount() {
  return db().users.filter((u) => u.isAdmin && !u.disabled).length;
}
app.get('/api/users', P('users.manage'), (_req, res) => res.json(db().users.map(auth.publicUser)));
app.post('/api/users', P('users.manage'), json, (req, res) => {
  const d = db();
  const username = String(req.body.username || '').trim();
  if (!/^[a-zA-Z0-9_.@-]{2,64}$/.test(username)) return res.status(400).json({ error: 'Username: 2-64 letters, numbers, _ . @ -' });
  if (d.users.some((x) => x.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'Username taken' });
  const err = auth.validatePassword(req.body.password);
  if (err) return res.status(400).json({ error: err });
  if (req.body.isAdmin && !req.user.isAdmin) return res.status(403).json({ error: 'Only admins can create admins' });
  const u = {
    id: id(),
    username,
    passwordHash: auth.hashPassword(req.body.password),
    source: 'local',
    isAdmin: !!req.body.isAdmin,
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
  if ((u.isAdmin || req.body.isAdmin) && !req.user.isAdmin) return res.status(403).json({ error: 'Only admins can change admin accounts' });
  if (u.id === req.user.id && (req.body.isAdmin === false || req.body.disabled)) {
    return res.status(400).json({ error: 'You cannot remove your own admin rights or disable yourself' });
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
  if (req.body.isAdmin !== undefined) u.isAdmin = !!req.body.isAdmin;
  if (req.body.disabled !== undefined) u.disabled = !!req.body.disabled;
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
app.delete('/api/users/:id', P('users.manage'), (req, res) => {
  const d = db();
  const u = d.users.find((x) => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  if (u.isAdmin && !req.user.isAdmin) return res.status(403).json({ error: 'Only admins can delete admins' });
  if (u.isAdmin && adminCount() <= 1) return res.status(400).json({ error: 'At least one active admin is required' });
  d.users = d.users.filter((x) => x.id !== u.id);
  auth.destroyUserSessions(u.id);
  save();
  res.json({ ok: true });
});

// ------------------------------------------------------------------ settings
function settingsOut(req) {
  const s = db().settings;
  return {
    publicUrl: s.publicUrl,
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

// ------------------------------------------------------------------ files
app.use('/api/files', files.router());

// ------------------------------------------------------------------ static UI
app.use('/vendor/xterm', express.static(path.join(path.dirname(require.resolve('@xterm/xterm/package.json')))));
app.use('/vendor/xterm-fit', express.static(path.join(path.dirname(require.resolve('@xterm/addon-fit/package.json')))));
app.use(express.static(path.join(__dirname, '..', 'public')));
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

async function stop() {
  console.log('[pagemaster] shutting down');
  await sites.shutdown();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
