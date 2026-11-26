// OpenID Connect SSO (works with Authentik, Authelia, Keycloak, Zitadel,
// Google, Microsoft Entra, GitLab, Pocket ID, etc.)
const { Issuer, generators } = require('openid-client');
const { db, save, id } = require('./db');
const auth = require('./auth');

let cached = { key: '', client: null };
const pending = new Map(); // state -> { verifier, nonce, expires }

function settings() {
  return db().settings;
}

function redirectUri(req) {
  const base = (settings().publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  return `${base}/auth/sso/callback`;
}

async function getClient(req) {
  const s = settings().sso;
  const redirect = redirectUri(req);
  const key = [s.issuer, s.clientId, s.clientSecret, redirect].join('|');
  if (cached.key === key && cached.client) return cached.client;
  const issuer = await Issuer.discover(s.issuer);
  const client = new issuer.Client({
    client_id: s.clientId,
    client_secret: s.clientSecret || undefined,
    token_endpoint_auth_method: s.clientSecret ? 'client_secret_basic' : 'none',
    redirect_uris: [redirect],
    response_types: ['code'],
  });
  cached = { key, client };
  return client;
}

function resetClient() {
  cached = { key: '', client: null };
}

function register(app) {
  app.get('/auth/sso/login', async (req, res) => {
    const s = settings().sso;
    if (!s.enabled || !s.issuer || !s.clientId) return res.redirect('/?error=' + encodeURIComponent('SSO is not configured'));
    try {
      const client = await getClient(req);
      const state = generators.state();
      const nonce = generators.nonce();
      const verifier = generators.codeVerifier();
      // clean old entries
      const now = Date.now();
      for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
      pending.set(state, { verifier, nonce, expires: now + 10 * 60000 });
      const url = client.authorizationUrl({
        scope: s.scopes || 'openid profile email',
        state,
        nonce,
        code_challenge: generators.codeChallenge(verifier),
        code_challenge_method: 'S256',
      });
      res.redirect(url);
    } catch (e) {
      console.error('[sso] login error', e.message);
      res.redirect('/?error=' + encodeURIComponent('SSO error: ' + e.message));
    }
  });

  app.get('/auth/sso/callback', async (req, res) => {
    try {
      const client = await getClient(req);
      const params = client.callbackParams(req);
      const p = pending.get(params.state);
      if (!p) throw new Error('Login session expired, try again');
      pending.delete(params.state);
      const tokenSet = await client.callback(redirectUri(req), params, {
        state: params.state,
        nonce: p.nonce,
        code_verifier: p.verifier,
      });
      let claims = tokenSet.claims();
      try {
        const info = await client.userinfo(tokenSet);
        claims = Object.assign({}, info, claims);
      } catch (_) { /* userinfo optional */ }

      const user = upsertSsoUser(claims);
      if (!user) throw new Error('No account for this SSO user (auto-create is disabled)');
      if (user.disabled) throw new Error('Account disabled');
      auth.createSession(res, user);
      res.redirect('/');
    } catch (e) {
      console.error('[sso] callback error', e.message);
      res.redirect('/?error=' + encodeURIComponent('SSO error: ' + e.message));
    }
  });
}

function upsertSsoUser(claims) {
  const d = db();
  const s = d.settings.sso;
  const subject = `${claims.iss}|${claims.sub}`;
  let u = d.users.find((x) => x.ssoSubject === subject);
  if (!u) {
    if (!s.autoCreate) return null;
    let base = String(claims.preferred_username || claims.email || claims.sub).replace(/[^a-zA-Z0-9_.@-]/g, '').slice(0, 64) || 'sso-user';
    let name = base;
    let i = 1;
    while (d.users.some((x) => x.username.toLowerCase() === name.toLowerCase())) name = `${base}-${++i}`;
    u = {
      id: id(),
      username: name,
      source: 'sso',
      ssoSubject: subject,
      isAdmin: false,
      // Lowest access until an admin changes it
      permissions: Array.isArray(s.defaultPermissions) ? s.defaultPermissions.slice() : ['sites.view'],
      mustChangePassword: false,
      disabled: false,
      createdAt: Date.now(),
    };
    d.users.push(u);
    console.log(`[sso] Created user ${name} with permissions: ${u.permissions.join(', ') || '(none)'}`);
  }
  u.displayName = claims.name || u.displayName || '';
  u.email = claims.email || u.email || '';
  save();
  return u;
}

module.exports = { register, resetClient, redirectUri };
