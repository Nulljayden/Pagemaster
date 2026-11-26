// Per-site visitor analytics, recorded on the hosting port. No cookies, no
// JavaScript in the site, no third parties: counts come from the requests
// Pagemaster serves. Visitors are counted per day with a salted hash of
// IP + user agent; the salt changes daily, so they can't be tracked across days.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const FILE = path.join(config.DATA_DIR, 'analytics.json');
const KEEP_DAYS = 400;
const MAX_KEYS = 300; // per top-list per day; the rest is grouped as "(other)"
const MAX_UNIQUES = 100000; // per site per day
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|embedly|preview|monitor|uptime|curl|wget|python-requests|go-http-client|headless/i;

let data = null; // { sites: { [siteId]: { [day]: DayStats } }, today: { day, salt, seen: { [siteId]: [hash] } } }
let seen = new Map(); // siteId -> Set(hash) for today
let dirty = false;

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function load() {
  try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { data = {}; }
  data.sites = data.sites || {};
  if (!data.today || data.today.day !== dayKey()) data.today = { day: dayKey(), salt: crypto.randomBytes(16).toString('hex'), seen: {} };
  seen = new Map(Object.entries(data.today.seen || {}).map(([k, v]) => [k, new Set(v)]));
  prune();
}

function flush() {
  if (!data || !dirty) return;
  dirty = false;
  data.today.seen = Object.fromEntries([...seen].map(([k, v]) => [k, [...v]]));
  try {
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(data));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) { console.error('[analytics] save failed', e.message); }
}

function prune() {
  const cutoff = dayKey(Date.now() - KEEP_DAYS * 86400000);
  for (const days of Object.values(data.sites)) {
    for (const k of Object.keys(days)) if (k < cutoff) delete days[k];
  }
}

function rollDay() {
  const today = dayKey();
  if (data.today.day === today) return;
  data.today = { day: today, salt: crypto.randomBytes(16).toString('hex'), seen: {} };
  seen = new Map();
  prune();
}

function bump(map, key, n = 1) {
  if (!key) return;
  if (!(key in map) && Object.keys(map).length >= MAX_KEYS) key = '(other)';
  map[key] = (map[key] || 0) + n;
}

function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
}

function newDay() {
  return { req: 0, pv: 0, uv: 0, bytes: 0, bots: 0, status: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 }, paths: {}, refs: {}, countries: {}, hosts: {}, hours: new Array(24).fill(0) };
}

// Call before the response is produced; counts once it has been sent.
function track(site, req, res) {
  if (!data || req._pmPreview) return; // the panel's own previews don't count
  let bytes = 0;
  const count = (chunk) => {
    if (chunk && typeof chunk !== 'function') {
      try { bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length || 0; } catch (_) {}
    }
  };
  const w = res.write;
  const e = res.end;
  res.write = function (chunk, ...a) { count(chunk); return w.call(this, chunk, ...a); };
  res.end = function (chunk, ...a) { count(chunk); return e.call(this, chunk, ...a); };
  const method = req.method;
  const url = req.url || '/';
  res.once('finish', () => {
    try { record(site.id, req, res, method, url, bytes); } catch (err) { console.error('[analytics]', err.message); }
  });
}

function record(siteId, req, res, method, url, bytes) {
  rollDay();
  const days = data.sites[siteId] || (data.sites[siteId] = {});
  const d = days[data.today.day] || (days[data.today.day] = newDay());
  const status = res.statusCode;
  d.req++;
  d.bytes += bytes;
  const cls = `${Math.floor(status / 100)}xx`;
  if (cls in d.status) d.status[cls]++;
  const ua = String(req.headers['user-agent'] || '');
  if (!ua || BOT_RE.test(ua)) { d.bots++; dirty = true; return; }

  const ct = String(res.getHeader('content-type') || '');
  const dest = req.headers['sec-fetch-dest'];
  const isPage = (method === 'GET') && status < 400 && (dest ? dest === 'document' : /text\/html/.test(ct));
  if (!isPage) { dirty = true; return; }

  d.pv++;
  d.hours[new Date().getHours()]++;
  const hash = crypto.createHash('sha256').update(`${data.today.salt}|${siteId}|${clientIp(req)}|${ua}`).digest('base64').slice(0, 16);
  let set = seen.get(siteId);
  if (!set) { set = new Set(); seen.set(siteId, set); }
  if (!set.has(hash) && set.size < MAX_UNIQUES) { set.add(hash); d.uv++; }

  bump(d.paths, url.split('?')[0].slice(0, 200) || '/');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().replace(/:\d+$/, '').toLowerCase();
  bump(d.hosts, host);
  let ref = '(direct)';
  try {
    const r = new URL(req.headers.referer);
    if (r.hostname.toLowerCase() !== host) ref = r.hostname.replace(/^www\./, '');
  } catch (_) { /* none */ }
  if (ref !== '(direct)' || !req.headers.referer) bump(d.refs, ref);
  const cc = String(req.headers['cf-ipcountry'] || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(cc) && cc !== 'XX') bump(d.countries, cc);
  dirty = true;
}

function top(map, n = 10) {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));
}

// Summary for the last `days` days (including today)
function summary(siteId, days = 30) {
  days = Math.max(1, Math.min(KEEP_DAYS, parseInt(days, 10) || 30));
  const all = (data && data.sites[siteId]) || {};
  const series = [];
  const tot = newDay();
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(Date.now() - i * 86400000);
    const d = all[k];
    series.push({ date: k, pv: d ? d.pv : 0, uv: d ? d.uv : 0, req: d ? d.req : 0, bytes: d ? d.bytes : 0 });
    if (!d) continue;
    for (const f of ['req', 'pv', 'uv', 'bytes', 'bots']) tot[f] += d[f] || 0;
    for (const c of Object.keys(tot.status)) tot.status[c] += (d.status && d.status[c]) || 0;
    for (const f of ['paths', 'refs', 'countries', 'hosts']) for (const [kk, v] of Object.entries(d[f] || {})) tot[f][kk] = (tot[f][kk] || 0) + v;
    (d.hours || []).forEach((v, h) => { tot.hours[h] += v; });
  }
  return {
    days,
    series,
    totals: { pageviews: tot.pv, visitors: tot.uv, requests: tot.req, bytes: tot.bytes, bots: tot.bots, status: tot.status },
    hours: tot.hours,
    paths: top(tot.paths),
    referrers: top(tot.refs),
    countries: top(tot.countries),
    hosts: top(tot.hosts),
  };
}

function quick(siteId, days = 7) {
  const all = (data && data.sites[siteId]) || {};
  let pv = 0;
  let uv = 0;
  for (let i = 0; i < days; i++) {
    const d = all[dayKey(Date.now() - i * 86400000)];
    if (d) { pv += d.pv; uv += d.uv; }
  }
  return { pageviews: pv, visitors: uv };
}

function reset(siteId) {
  if (!data) return;
  delete data.sites[siteId];
  seen.delete(siteId);
  dirty = true;
  flush();
}

function start() {
  load();
  setInterval(flush, 30000).unref();
}

module.exports = { start, track, summary, quick, reset, flush, removeSite: reset };
