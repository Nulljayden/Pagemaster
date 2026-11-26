// File browser API, rooted at the sites directory.
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const auth = require('./auth');
const access = require('./access');
const { db } = require('./db');

const ROOT = config.SITES_DIR;
const MAX_EDIT = 2 * 1024 * 1024; // only edit text files up to 2MB in the browser

function safe(p) {
  const rel = String(p || '').replace(/\\/g, '/');
  const full = path.resolve(ROOT, '.' + path.posix.normalize('/' + rel));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) throw Object.assign(new Error('Path outside root'), { status: 400 });
  // Resolve symlinks of the existing part of the path too
  let probe = full;
  while (!fs.existsSync(probe) && probe !== ROOT) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  const realRoot = fs.realpathSync(ROOT);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw Object.assign(new Error('Path outside root'), { status: 400 });
  return full;
}

function rel(full) {
  return '/' + path.relative(ROOT, full).split(path.sep).join('/');
}

// Global files.read/files.write covers every folder. Otherwise a user only sees
// the folders of sites shared with them (/<slug>/...), and nothing else at the root.
function siteForPath(full) {
  const r = path.relative(ROOT, full);
  if (!r) return null;
  const slug = r.split(path.sep)[0];
  return db().sites.find((s) => s.slug === slug) || null;
}

function allowed(user, full, perm) {
  if (auth.can(user, perm)) return true;
  const site = siteForPath(full);
  return !!site && access.siteCan(user, site, perm);
}

function check(req, full, perm) {
  if (!allowed(req.user, full, perm)) {
    throw Object.assign(new Error(perm === 'files.write' ? 'You can only change files of sites shared with you for editing' : 'No access to this folder'), { status: 403 });
  }
  return full;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      try {
        const dir = check(req, safe(req.query.path), 'files.write');
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (e) { cb(e); }
    },
    filename: (_req, file, cb) => cb(null, path.basename(Buffer.from(file.originalname, 'latin1').toString('utf8'))),
  }),
  limits: { fileSize: 1024 * 1024 * 1024 },
});

function router() {
  const r = express.Router();
  r.use(auth.requireAuth);
  // Only users with some file access get past this point
  const any = (req, res, next) => {
    if (auth.can(req.user, 'files.read') || access.anySite(req.user, 'files.read')) return next();
    res.status(403).json({ error: 'Missing permission: files.read' });
  };
  const read = any;
  const write = any;

  r.get('/list', read, (req, res) => {
    const dir = safe(req.query.path);
    const scoped = !auth.can(req.user, 'files.read');
    if (!(scoped && dir === ROOT)) check(req, dir, 'files.read');
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(404).json({ error: 'Not a directory' });
    let names = fs.readdirSync(dir, { withFileTypes: true });
    if (scoped && dir === ROOT) names = names.filter((e) => allowed(req.user, path.join(ROOT, e.name), 'files.read'));
    const entries = names.map((e) => {
      let st = null;
      try { st = fs.statSync(path.join(dir, e.name)); } catch (_) {}
      return {
        name: e.name,
        dir: st ? st.isDirectory() : e.isDirectory(),
        size: st ? st.size : 0,
        mtime: st ? st.mtimeMs : 0,
        link: e.isSymbolicLink(),
      };
    }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    res.json({ path: rel(dir), entries, writable: allowed(req.user, dir, 'files.write') });
  });

  r.get('/read', read, (req, res) => {
    const f = check(req, safe(req.query.path), 'files.read');
    const st = fs.statSync(f);
    if (st.isDirectory()) return res.status(400).json({ error: 'Is a directory' });
    if (st.size > MAX_EDIT) return res.status(413).json({ error: 'File too large to edit in browser, download it instead' });
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) return res.status(415).json({ error: 'Binary file, download it instead' });
    res.json({ path: rel(f), content: buf.toString('utf8'), writable: allowed(req.user, f, 'files.write') });
  });

  r.get('/download', read, (req, res) => {
    const f = check(req, safe(req.query.path), 'files.read');
    if (fs.statSync(f).isDirectory()) return res.status(400).json({ error: 'Is a directory' });
    res.download(f, path.basename(f), { dotfiles: 'allow' });
  });

  r.put('/write', write, express.json({ limit: '5mb' }), (req, res) => {
    const f = check(req, safe(req.body.path), 'files.write');
    if (path.dirname(f) === ROOT && !auth.can(req.user, 'files.write')) throw Object.assign(new Error('No access to this folder'), { status: 403 });
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, String(req.body.content ?? ''));
    res.json({ ok: true });
  });

  r.post('/mkdir', write, express.json(), (req, res) => {
    fs.mkdirSync(check(req, safe(req.body.path), 'files.write'), { recursive: true });
    res.json({ ok: true });
  });

  r.post('/rename', write, express.json(), (req, res) => {
    const from = check(req, safe(req.body.from), 'files.write');
    const to = check(req, safe(req.body.to), 'files.write');
    // Renaming a site's own folder would break the site
    if (!auth.can(req.user, 'files.write') && (path.dirname(from) === ROOT || path.dirname(to) === ROOT)) {
      return res.status(403).json({ error: 'You can only change files inside a site folder' });
    }
    if (from === ROOT) return res.status(400).json({ error: 'Cannot rename root' });
    if (fs.existsSync(to)) return res.status(409).json({ error: 'Target already exists' });
    fs.renameSync(from, to);
    res.json({ ok: true });
  });

  r.delete('/delete', write, (req, res) => {
    const f = check(req, safe(req.query.path), 'files.write');
    if (f === ROOT) return res.status(400).json({ error: 'Cannot delete root' });
    if (path.dirname(f) === ROOT && !auth.can(req.user, 'files.write')) return res.status(403).json({ error: 'You can only change files inside a site folder' });
    fs.rmSync(f, { recursive: true, force: true });
    res.json({ ok: true });
  });

  r.post('/upload', write, upload.array('files'), (req, res) => {
    res.json({ ok: true, count: (req.files || []).length });
  });

  return r;
}

module.exports = { router, ROOT };
