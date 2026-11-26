const path = require('path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');

function parseRange(str) {
  const m = String(str || '').match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  return a <= b ? [a, b] : [b, a];
}

module.exports = {
  DATA_DIR,
  SITES_DIR: path.join(DATA_DIR, 'sites'),
  LOGS_DIR: path.join(DATA_DIR, 'logs'),
  SSH_DIR: path.join(DATA_DIR, 'ssh'),
  // Admin web UI
  ADMIN_PORT: parseInt(process.env.ADMIN_PORT || '38080', 10),
  // Shared hosting port (routes by hostname or /<slug>/ path)
  HOSTING_PORT: parseInt(process.env.HOSTING_PORT || '38081', 10),
  // Host port the sites are published on, if it differs from HOSTING_PORT (used for links in the UI)
  HOSTING_PUBLIC_PORT: parseInt(process.env.HOSTING_PUBLIC_PORT || process.env.HOSTING_PORT || '38081', 10),
  // Cloudflare tunnels
  CLOUDFLARED_BIN: process.env.CLOUDFLARED_BIN || 'cloudflared',
  CF_API_BASE: process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4',
  // Ports a site may claim as its own dedicated port (must be published in Docker)
  SITE_PORT_RANGE: parseRange(process.env.SITE_PORT_RANGE || '8100-8199'),
  // Internal loopback ports used by "node app" sites behind the proxy
  APP_PORT_RANGE: parseRange(process.env.APP_PORT_RANGE || '20000-20999'),
  // Set to "true" when behind a reverse proxy doing HTTPS
  TRUST_PROXY: process.env.TRUST_PROXY === 'true',
  COOKIE_SECURE: process.env.COOKIE_SECURE === 'true',
  SESSION_DAYS: parseInt(process.env.SESSION_DAYS || '7', 10),
};
