// Simple JSON-file database stored on the /data volume.
// Small, dependency-free and easy to back up (just copy /data).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const DB_FILE = path.join(config.DATA_DIR, 'pagemaster.json');
const KEY_FILE = path.join(config.DATA_DIR, 'secret.key');

const PERMISSIONS = {
  'sites.view': 'View sites and their status/logs',
  'sites.deploy': 'Pull / redeploy / start / stop sites',
  'sites.manage': 'Add, edit and delete sites',
  'credentials.manage': 'Manage git tokens and SSH key',
  'files.read': 'Browse and download files',
  'files.write': 'Upload, edit, rename and delete files',
  'terminal': 'Use the built-in shell (full container access)',
  'tunnels.manage': 'Connect your own Cloudflare account and publish sites through your tunnels',
  'users.manage': 'Manage users and permissions',
  'settings.manage': 'Change SSO and system settings',
};

const DEFAULT_SETTINGS = {
  publicUrl: '',
  sitesUrl: '',
  sitesBaseDomain: '',
  sso: {
    enabled: false,
    label: 'Sign in with SSO',
    issuer: '',
    clientId: '',
    clientSecret: '',
    scopes: 'openid profile email',
    autoCreate: true,
    // SSO users get the lowest access until an admin changes it
    defaultPermissions: ['sites.view'],
  },
};

let state = null;

function ensureDirs() {
  for (const d of [config.DATA_DIR, config.SITES_DIR, config.LOGS_DIR, config.SSH_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
  try { fs.chmodSync(config.SSH_DIR, 0o700); } catch (_) {}
}

function getKey() {
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
}

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['v1', iv.toString('hex'), c.getAuthTag().toString('hex'), enc.toString('hex')].join(':');
}

function decrypt(blob) {
  if (!blob) return '';
  const [v, iv, tag, enc] = String(blob).split(':');
  if (v !== 'v1') return '';
  const d = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(enc, 'hex')), d.final()]).toString('utf8');
}

function load() {
  ensureDirs();
  if (fs.existsSync(DB_FILE)) {
    state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } else {
    state = {};
  }
  state.users = state.users || [];
  state.sessions = state.sessions || [];
  state.sites = state.sites || [];
  state.credentials = state.credentials || [];
  state.tunnels = state.tunnels || [];
  state.settings = Object.assign({}, DEFAULT_SETTINGS, state.settings || {});
  state.settings.sso = Object.assign({}, DEFAULT_SETTINGS.sso, state.settings.sso || {});

  // Drop expired sessions on start
  const now = Date.now();
  state.sessions = state.sessions.filter((s) => s.expires > now);
  save();
  return state;
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}

function db() {
  if (!state) load();
  return state;
}

function id() {
  return crypto.randomBytes(8).toString('hex');
}

module.exports = { db, load, save, id, encrypt, decrypt, PERMISSIONS };
