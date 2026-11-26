// Per-site Node.js versions. The image ships one Node.js (the one Pagemaster runs
// on). Other versions are downloaded from nodejs.org on first use into
// /data/node/<version>/ and put first on PATH for that site's install, build
// and start commands (so node, npm, npx and corepack all match).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./config');

const NODE_DIR = path.join(config.DATA_DIR, 'node');
const DIST = process.env.NODE_DIST_URL || 'https://nodejs.org/dist';
const ARCH = { x64: 'x64', arm64: 'arm64' }[process.arch] || process.arch;
const BUILTIN = process.versions.node; // e.g. 22.11.0
const VERSION_RE = /^\d{1,2}(\.\d+\.\d+)?$/;

let indexCache = { at: 0, list: null };
const installing = new Map(); // version -> Promise<binDir>

async function index() {
  if (indexCache.list && Date.now() - indexCache.at < 6 * 3600000) return indexCache.list;
  const res = await fetch(`${DIST}/index.json`);
  if (!res.ok) throw new Error(`nodejs.org returned HTTP ${res.status}`);
  indexCache = { at: Date.now(), list: await res.json() };
  return indexCache.list;
}

// Majors offered in the UI: newest release of each major from 18 up.
async function available() {
  const out = { builtin: BUILTIN, installed: installed(), versions: [] };
  try {
    const seen = new Set();
    for (const r of await index()) {
      const major = r.version.slice(1).split('.')[0];
      if (r.version.includes('-') || +major < 18 || seen.has(major)) continue; // skip pre-releases
      seen.add(major);
      out.versions.push({ major, latest: r.version.slice(1), lts: r.lts || false });
    }
  } catch (e) {
    out.error = `Could not load the version list from nodejs.org (${e.message}). Already-downloaded versions still work.`;
  }
  return out;
}

function installed() {
  try {
    return fs.readdirSync(NODE_DIR).filter((d) => fs.existsSync(path.join(NODE_DIR, d, '.complete'))).sort();
  } catch (_) { return []; }
}

// "20" -> newest 20.x.y; "20.11.1" -> exactly that
async function resolve(want) {
  if (/^\d+\.\d+\.\d+$/.test(want)) return want;
  const local = installed().filter((v) => v.startsWith(want + '.'));
  try {
    const hit = (await index()).find((r) => r.version.startsWith(`v${want}.`) && !r.version.includes('-') && (r.files || []).includes(`linux-${ARCH}`));
    if (hit) return hit.version.slice(1);
  } catch (e) {
    if (local.length) return local[local.length - 1]; // offline: use what we have
    throw e;
  }
  if (local.length) return local[local.length - 1];
  throw new Error(`Node.js ${want} is not available for linux-${ARCH}`);
}

async function download(version, log) {
  const dir = path.join(NODE_DIR, version);
  const tmp = `${dir}.tmp-${process.pid}`;
  const file = `${tmp}.tar.gz`;
  fs.mkdirSync(NODE_DIR, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  const url = `${DIST}/v${version}/node-v${version}-linux-${ARCH}.tar.gz`;
  log(`Downloading Node.js ${version} (${url})`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Downloading Node.js ${version} failed: HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  try {
    fs.mkdirSync(tmp, { recursive: true });
    execFileSync('tar', ['-xzf', file, '-C', tmp, '--strip-components=1']);
    fs.writeFileSync(path.join(tmp, '.complete'), new Date().toISOString());
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  log(`Node.js ${version} installed`);
}

// Returns the bin directory to put first on PATH, or null for the built-in Node.js
async function binDir(want, log = () => {}) {
  want = String(want || '').trim();
  if (!want) return null;
  if (!VERSION_RE.test(want)) throw new Error(`Invalid Node.js version "${want}"`);
  const version = await resolve(want);
  if (version === BUILTIN) return null;
  const dir = path.join(NODE_DIR, version);
  if (!fs.existsSync(path.join(dir, '.complete'))) {
    if (!installing.has(version)) {
      installing.set(version, download(version, log).finally(() => installing.delete(version)));
    }
    await installing.get(version);
  }
  return path.join(dir, 'bin');
}

// Synchronous lookup for an already-installed version (used when (re)starting apps)
function installedBin(want) {
  want = String(want || '').trim();
  if (!want) return null;
  const match = installed().filter((v) => v === want || v.startsWith(want + '.'));
  const v = match[match.length - 1];
  if (!v || v === BUILTIN) return null;
  return path.join(NODE_DIR, v, 'bin');
}

function withNode(env, bin) {
  if (!bin) return env;
  return { ...env, PATH: `${bin}:${env.PATH || process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}` };
}

module.exports = { available, binDir, installedBin, withNode, VERSION_RE, BUILTIN };
