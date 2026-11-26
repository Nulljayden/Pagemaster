const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { db, save, id, PERMISSIONS } = require('./db');

const COOKIE = 'pm_session';

function ensureDefaultAdmin() {
  const d = db();
  if (d.users.length === 0) {
    d.users.push({
      id: id(),
      username: 'admin',
      passwordHash: bcrypt.hashSync('admin', 10),
      source: 'local',
      isAdmin: true,
      permissions: Object.keys(PERMISSIONS),
      mustChangePassword: true,
      disabled: false,
      createdAt: Date.now(),
    });
    save();
    console.log('[auth] Created default user admin/admin - change it after first login!');
  }
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName || '',
    email: u.email || '',
    source: u.source,
    isAdmin: !!u.isAdmin,
    permissions: u.isAdmin ? Object.keys(PERMISSIONS) : (u.permissions || []),
    mustChangePassword: !!u.mustChangePassword,
    disabled: !!u.disabled,
    createdAt: u.createdAt,
    lastLogin: u.lastLogin || null,
    hasPassword: !!u.passwordHash,
    ssoLinked: !!u.ssoSubject,
    ssoName: u.ssoSubject ? (u.ssoName || '') : '',
  };
}

function can(user, perm) {
  if (!user || user.disabled) return false;
  if (user.isAdmin) return true;
  return (user.permissions || []).includes(perm);
}

function createSession(res, user) {
  const d = db();
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + config.SESSION_DAYS * 86400000;
  d.sessions.push({ token: hash(token), userId: user.id, expires });
  user.lastLogin = Date.now();
  save();
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    expires: new Date(expires),
    path: '/',
  });
}

function hash(t) {
  return crypto.createHash('sha256').update(t).digest('hex');
}

function userFromToken(token) {
  if (!token) return null;
  const d = db();
  const h = hash(token);
  const s = d.sessions.find((x) => x.token === h);
  if (!s || s.expires < Date.now()) return null;
  const u = d.users.find((x) => x.id === s.userId);
  if (!u || u.disabled) return null;
  return u;
}

// Short id of the current session (used to tie private-site cookies to it, so
// signing out of Pagemaster also signs out of private sites)
function sessionKey(req) {
  const token = req.cookies && req.cookies[COOKIE];
  return token ? hash(token).slice(0, 24) : '';
}

function sessionAlive(key) {
  if (!key) return false;
  const now = Date.now();
  return db().sessions.some((s) => s.expires > now && s.token.startsWith(key));
}

function destroySession(req, res) {
  const token = req.cookies && req.cookies[COOKIE];
  if (token) {
    const d = db();
    const h = hash(token);
    d.sessions = d.sessions.filter((s) => s.token !== h);
    save();
  }
  res.clearCookie(COOKIE, { path: '/' });
}

function destroyUserSessions(userId, exceptToken) {
  const d = db();
  const keep = exceptToken ? hash(exceptToken) : null;
  d.sessions = d.sessions.filter((s) => s.userId !== userId || s.token === keep);
  save();
}

// Express middleware: attaches req.user
function attachUser(req, _res, next) {
  req.user = userFromToken(req.cookies && req.cookies[COOKIE]);
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in' });
    if (!can(req.user, perm)) return res.status(403).json({ error: `Missing permission: ${perm}` });
    next();
  };
}

// Basic CSRF protection: mutating API calls must carry a custom header,
// which browsers will not send cross-site without a CORS preflight.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-pagemaster') !== '1') return res.status(403).json({ error: 'Missing CSRF header' });
  next();
}

// Login rate limiting (per IP)
const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const a = attempts.get(ip) || { count: 0, reset: now + 15 * 60000 };
  if (a.reset < now) { a.count = 0; a.reset = now + 15 * 60000; }
  attempts.set(ip, a);
  return a.count >= 10;
}
function recordFail(ip) {
  const a = attempts.get(ip);
  if (a) a.count++;
}
function clearFails(ip) { attempts.delete(ip); }

function verifyLocal(username, password) {
  const u = db().users.find((x) => x.username.toLowerCase() === String(username || '').toLowerCase());
  if (!u || u.disabled || !u.passwordHash) return null;
  return bcrypt.compareSync(String(password || ''), u.passwordHash) ? u : null;
}

function validatePassword(pw) {
  if (!pw || String(pw).length < 8) return 'Password must be at least 8 characters';
  if (pw === 'admin') return 'Choose a different password';
  return null;
}

module.exports = {
  COOKIE,
  ensureDefaultAdmin,
  publicUser,
  can,
  createSession,
  destroySession,
  destroyUserSessions,
  sessionKey,
  sessionAlive,
  userFromToken,
  attachUser,
  requireAuth,
  requirePerm,
  csrfGuard,
  rateLimited,
  recordFail,
  clearFails,
  verifyLocal,
  validatePassword,
  hashPassword: (pw) => bcrypt.hashSync(pw, 10),
};
