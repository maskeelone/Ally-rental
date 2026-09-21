'use strict';
/**
 * Ally Rentals LLC: website + admin backend.
 * Zero dependencies. Needs Node 18 or newer. Start with:  node server.js
 *
 * Environment variables (all optional):
 *   ADMIN_TOKEN  admin login token (default: moses7734)
 *   PORT / SERVER_PORT  port to listen on (default: 3000)
 *   DATA_DIR     where listings, messages and photos are stored (default: ./data)
 *   TRUST_PROXY  set to 1 if you run behind nginx/Cloudflare so real visitor IPs are used
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.SERVER_PORT || process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'moses7734';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_FILE = path.join(__dirname, 'views', 'admin.html');
const TRUST_PROXY = !!process.env.TRUST_PROXY;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------- tiny JSON store ---------- */
const FILES = { listings: 'listings.json', inquiries: 'inquiries.json', settings: 'settings.json' };
const DEFAULTS = {
  listings: () => [],
  inquiries: () => [],
  settings: () => ({ phone: '', email: '', address: '', hours: '' }),
};
const cache = {};
function load(name) {
  if (cache[name]) return cache[name];
  try {
    cache[name] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, FILES[name]), 'utf8'));
  } catch {
    cache[name] = DEFAULTS[name]();
    save(name);
  }
  return cache[name];
}
function save(name) {
  const file = path.join(DATA_DIR, FILES[name]);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache[name], null, 2));
  fs.renameSync(tmp, file);
}

/* ---------- helpers ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};
const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_UPLOAD = 8 * 1024 * 1024;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SEC });
  res.end(body);
}
function fail(status, message) {
  return Object.assign(new Error(message), { status });
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) { req.resume(); return reject(fail(413, 'That file is too large. The limit is 8 MB.')); }
    const chunks = [];
    let size = 0, tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { tooBig = true; return; }
      if (!tooBig) chunks.push(c);
    });
    req.on('end', () => (tooBig ? reject(fail(413, 'That request is too large.')) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req, 200 * 1024);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw fail(400, 'Bad request.'); }
}
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || 'unknown';
}
const buckets = new Map();
function allow(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) { buckets.set(key, { n: 1, reset: now + windowMs }); return true; }
  b.n += 1;
  return b.n <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k); }, 5 * 60 * 1000).unref();

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const rid = () => crypto.randomBytes(6).toString('hex');

/* ---------- admin sessions (in memory; signing in again is needed after a restart) ---------- */
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
function authed(req) {
  const h = String(req.headers.authorization || '');
  const id = h.startsWith('Bearer ') ? h.slice(7) : '';
  const exp = sessions.get(id);
  if (!exp || exp < Date.now()) { sessions.delete(id); return null; }
  return id;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of sessions) if (v < now) sessions.delete(k); }, 10 * 60 * 1000).unref();

/* ---------- validation ---------- */
const STATUSES = ['available', 'pending', 'rented', 'draft'];
const TYPES = ['House', 'Townhome', 'Apartment', 'Condo', 'Duplex', 'Room'];
const PETS = ['No pets', 'Cats OK', 'Dogs OK', 'Cats and dogs OK'];
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0; };
const UPLOAD_URL = /^\/uploads\/([a-f0-9]+\.(?:jpg|png|webp|gif))$/;

function cleanListing(b, prev) {
  const images = (Array.isArray(b.images) ? b.images : [])
    .map(String)
    .filter((u) => UPLOAD_URL.test(u) || /^https:\/\/[^\s"'<>]+$/i.test(u))
    .slice(0, 24);
  return {
    id: prev ? prev.id : rid(),
    title: str(b.title, 120),
    status: STATUSES.includes(b.status) ? b.status : 'draft',
    featured: !!b.featured,
    price: num(b.price, 0, 10000000),
    deposit: num(b.deposit, 0, 10000000),
    address: str(b.address, 160),
    city: str(b.city, 80),
    state: str(b.state, 40),
    zip: str(b.zip, 12),
    type: TYPES.includes(b.type) ? b.type : 'House',
    beds: num(b.beds, 0, 50),
    baths: num(b.baths, 0, 50),
    sqft: num(b.sqft, 0, 1000000),
    pets: PETS.includes(b.pets) ? b.pets : 'No pets',
    parking: str(b.parking, 80),
    leaseTerm: str(b.leaseTerm, 60),
    availableFrom: /^\d{4}-\d{2}-\d{2}$/.test(b.availableFrom || '') ? b.availableFrom : '',
    amenities: (Array.isArray(b.amenities) ? b.amenities : []).map((a) => str(a, 40)).filter(Boolean).slice(0, 40),
    description: str(b.description, 5000),
    images,
    createdAt: prev ? prev.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
function removeUploads(urls) {
  for (const u of urls) {
    const m = UPLOAD_URL.exec(u);
    if (m) fs.unlink(path.join(UPLOAD_DIR, m[1]), () => {});
  }
}
const byNewest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));

/* ---------- API ---------- */
async function handleApi(req, res, p, m) {
  /* public */
  if (p === '/api/listings' && m === 'GET') {
    const list = load('listings').filter((l) => l.status === 'available' || l.status === 'pending').sort(byNewest);
    return sendJson(res, 200, list);
  }
  if (p === '/api/settings' && m === 'GET') return sendJson(res, 200, load('settings'));

  if (p === '/api/inquiries' && m === 'POST') {
    if (!allow('inq:' + clientIp(req), 10, 10 * 60 * 1000)) throw fail(429, 'Too many messages. Try again in a few minutes.');
    const b = await readJson(req);
    if (b.website) return sendJson(res, 200, { ok: true }); // honeypot field, bots fill it in
    const name = str(b.name, 80), email = str(b.email, 120), phone = str(b.phone, 40), message = str(b.message, 2000);
    if (!name || (!email && !phone) || !message) throw fail(400, 'Add your name, an email or phone number, and a message.');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, 'That email address does not look right.');
    const l = load('listings').find((x) => x.id === b.listingId);
    const all = load('inquiries');
    all.unshift({
      id: rid(), name, email, phone, message,
      listingId: l ? l.id : '', listingTitle: l ? l.title : '',
      read: false, createdAt: new Date().toISOString(),
    });
    if (all.length > 2000) all.length = 2000;
    save('inquiries');
    return sendJson(res, 200, { ok: true });
  }

  /* admin login */
  if (p === '/api/admin/login' && m === 'POST') {
    const ip = clientIp(req);
    if (!allow('login:' + ip, 8, 10 * 60 * 1000)) throw fail(429, 'Too many attempts. Wait a few minutes and try again.');
    const b = await readJson(req);
    if (!safeEqual(b.token || '', ADMIN_TOKEN)) {
      await new Promise((r) => setTimeout(r, 400));
      throw fail(401, 'That token is not right.');
    }
    buckets.delete('login:' + ip);
    const id = crypto.randomBytes(32).toString('hex');
    sessions.set(id, Date.now() + SESSION_MS);
    return sendJson(res, 200, { session: id });
  }

  /* everything below needs a valid admin session */
  if (p.startsWith('/api/admin/')) {
    const sid = authed(req);
    if (!sid) throw fail(401, 'Your session ended. Sign in again.');

    if (p === '/api/admin/logout' && m === 'POST') { sessions.delete(sid); return sendJson(res, 200, { ok: true }); }

    if (p === '/api/admin/listings' && m === 'GET') return sendJson(res, 200, [...load('listings')].sort(byNewest));

    if (p === '/api/admin/listings' && m === 'POST') {
      const l = cleanListing(await readJson(req), null);
      if (!l.title) throw fail(400, 'Add a title for the listing.');
      if (!l.city) throw fail(400, 'Add the city.');
      load('listings').unshift(l);
      save('listings');
      return sendJson(res, 200, l);
    }

    let mm = /^\/api\/admin\/listings\/([a-f0-9]+)$/.exec(p);
    if (mm) {
      const all = load('listings');
      const i = all.findIndex((x) => x.id === mm[1]);
      if (i < 0) throw fail(404, 'That listing no longer exists.');
      if (m === 'PUT') {
        const l = cleanListing(await readJson(req), all[i]);
        if (!l.title) throw fail(400, 'Add a title for the listing.');
        if (!l.city) throw fail(400, 'Add the city.');
        removeUploads(all[i].images.filter((u) => !l.images.includes(u)));
        all[i] = l;
        save('listings');
        return sendJson(res, 200, l);
      }
      if (m === 'PATCH') {
        const b = await readJson(req);
        if (STATUSES.includes(b.status)) all[i].status = b.status;
        if (typeof b.featured === 'boolean') all[i].featured = b.featured;
        all[i].updatedAt = new Date().toISOString();
        save('listings');
        return sendJson(res, 200, all[i]);
      }
      if (m === 'DELETE') {
        const [gone] = all.splice(i, 1);
        save('listings');
        removeUploads(gone.images);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (p === '/api/admin/upload' && m === 'POST') {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const ext = UPLOAD_TYPES[type];
      if (!ext) throw fail(400, 'Upload a JPG, PNG, WebP or GIF image.');
      const buf = await readBody(req, MAX_UPLOAD);
      if (!buf.length) throw fail(400, 'That file was empty.');
      const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
      return sendJson(res, 200, { url: '/uploads/' + name });
    }

    if (p === '/api/admin/inquiries' && m === 'GET') return sendJson(res, 200, load('inquiries'));
    mm = /^\/api\/admin\/inquiries\/([a-f0-9]+)$/.exec(p);
    if (mm) {
      const all = load('inquiries');
      const i = all.findIndex((x) => x.id === mm[1]);
      if (i < 0) throw fail(404, 'That message no longer exists.');
      if (m === 'PATCH') {
        const b = await readJson(req);
        if (typeof b.read === 'boolean') all[i].read = b.read;
        save('inquiries');
        return sendJson(res, 200, all[i]);
      }
      if (m === 'DELETE') { all.splice(i, 1); save('inquiries'); return sendJson(res, 200, { ok: true }); }
    }

    if (p === '/api/admin/settings' && m === 'GET') return sendJson(res, 200, load('settings'));
    if (p === '/api/admin/settings' && m === 'PUT') {
      const b = await readJson(req);
      cache.settings = {
        phone: str(b.phone, 40), email: str(b.email, 120),
        address: str(b.address, 200), hours: str(b.hours, 120),
      };
      save('settings');
      return sendJson(res, 200, cache.settings);
    }
  }
  throw fail(404, 'Not found.');
}

/* ---------- static files ---------- */
function safeJoin(root, rel) {
  const full = path.normalize(path.join(root, rel));
  return full === root || full.startsWith(root + path.sep) ? full : null;
}
function serveFile(req, res, file, cacheControl, extra) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'Not found.' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cacheControl,
      ...SEC, ...(extra || {}),
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { throw fail(400, 'Bad request.'); }

    if (p.startsWith('/api/')) return await handleApi(req, res, p, req.method);

    if (req.method !== 'GET' && req.method !== 'HEAD') throw fail(405, 'Method not allowed.');

    if (p === '/admin' || p === '/admin/') {
      return serveFile(req, res, ADMIN_FILE, 'no-store', { 'X-Robots-Tag': 'noindex, nofollow' });
    }
    if (p.startsWith('/uploads/')) {
      const f = safeJoin(UPLOAD_DIR, p.slice('/uploads/'.length));
      if (!f) throw fail(404, 'Not found.');
      return serveFile(req, res, f, 'public, max-age=2592000, immutable');
    }
    const f = safeJoin(PUBLIC_DIR, p === '/' ? 'index.html' : p.slice(1));
    if (!f) throw fail(404, 'Not found.');
    return serveFile(req, res, f, 'public, max-age=300');
  } catch (e) {
    if (res.headersSent) return res.end();
    const status = e.status || 500;
    if (!e.status) console.error(e);
    sendJson(res, status, { error: e.status ? e.message : 'Something went wrong on the server.' });
  }
});

process.on('uncaughtException', (e) => console.error('Uncaught:', e));
server.listen(PORT, HOST, () => {
  console.log(`Ally Rentals is running on port ${PORT}`);
  console.log('  Site:  /');
  console.log('  Admin: /admin');
});
