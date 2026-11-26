// File browser API, rooted at the sites directory.
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const { requirePerm } = require('./auth');

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

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      try {
        const dir = safe(req.query.path);
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
  const read = requirePerm('files.read');
  const write = requirePerm('files.write');

  r.get('/list', read, (req, res) => {
    const dir = safe(req.query.path);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return res.status(404).json({ error: 'Not a directory' });
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
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
    res.json({ path: rel(dir), entries });
  });

  r.get('/read', read, (req, res) => {
    const f = safe(req.query.path);
    const st = fs.statSync(f);
    if (st.isDirectory()) return res.status(400).json({ error: 'Is a directory' });
    if (st.size > MAX_EDIT) return res.status(413).json({ error: 'File too large to edit in browser, download it instead' });
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) return res.status(415).json({ error: 'Binary file, download it instead' });
    res.json({ path: rel(f), content: buf.toString('utf8') });
  });

  r.get('/download', read, (req, res) => {
    const f = safe(req.query.path);
    if (fs.statSync(f).isDirectory()) return res.status(400).json({ error: 'Is a directory' });
    res.download(f, path.basename(f), { dotfiles: 'allow' });
  });

  r.put('/write', write, express.json({ limit: '5mb' }), (req, res) => {
    const f = safe(req.body.path);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, String(req.body.content ?? ''));
    res.json({ ok: true });
  });

  r.post('/mkdir', write, express.json(), (req, res) => {
    fs.mkdirSync(safe(req.body.path), { recursive: true });
    res.json({ ok: true });
  });

  r.post('/rename', write, express.json(), (req, res) => {
    const from = safe(req.body.from);
    const to = safe(req.body.to);
    if (from === ROOT) return res.status(400).json({ error: 'Cannot rename root' });
    if (fs.existsSync(to)) return res.status(409).json({ error: 'Target already exists' });
    fs.renameSync(from, to);
    res.json({ ok: true });
  });

  r.delete('/delete', write, (req, res) => {
    const f = safe(req.query.path);
    if (f === ROOT) return res.status(400).json({ error: 'Cannot delete root' });
    fs.rmSync(f, { recursive: true, force: true });
    res.json({ ok: true });
  });

  r.post('/upload', write, upload.array('files'), (req, res) => {
    res.json({ ok: true, count: (req.files || []).length });
  });

  return r;
}

module.exports = { router, ROOT };
