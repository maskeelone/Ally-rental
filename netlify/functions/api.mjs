/**
 * Ally Rentals LLC backend as a single Netlify Function.
 * Handles /api/* and /uploads/*. Data and photos live in Netlify Blobs.
 *
 * Environment variables (set in Netlify: Site configuration > Environment variables):
 *   ADMIN_TOKEN     admin login token (falls back to moses7734 if you do not set one)
 *   SESSION_SECRET  optional extra secret used to sign admin sessions
 */
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';

export const config = { path: ['/api/*', '/uploads/*'] };

/* ---------- storage ---------- */
const data = () => getStore({ name: 'ally-data', consistency: 'strong' });
const media = () => getStore({ name: 'ally-uploads' });

const getListings = async () => (await data().get('listings', { type: 'json' })) || [];
const saveListings = (arr) => data().setJSON('listings', arr);
const getSettings = async () =>
  (await data().get('settings', { type: 'json' })) || { phone: '', email: '', address: '', hours: '' };

/* ---------- helpers ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => new HttpError(status, message);
const json = (status, obj) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
const rid = () => crypto.randomBytes(6).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adminToken = () => process.env.ADMIN_TOKEN || 'moses7734';

async function readJson(req) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > 200 * 1024) throw fail(413, 'That request is too large.');
  const text = await req.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw fail(400, 'Bad request.'); }
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* Rate limiting kept in Blobs, because serverless instances do not share memory. */
async function allow(key, max, windowMs) {
  const st = data();
  const k = 'rl/' + key;
  const now = Date.now();
  const rec = await st.get(k, { type: 'json' });
  if (!rec || rec.reset < now) { await st.setJSON(k, { n: 1, reset: now + windowMs }); return true; }
  rec.n += 1;
  await st.setJSON(k, rec);
  return rec.n <= max;
}
function ipKey(req, context) {
  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 24);
}

/* ---------- admin sessions: signed, stateless tokens (12 hours) ---------- */
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessionKey = () => crypto.createHash('sha256').update('ally-session:' + (process.env.SESSION_SECRET || adminToken())).digest();
const sign = (payload) => crypto.createHmac('sha256', sessionKey()).update(payload).digest('base64url');

function makeSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_MS, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return payload + '.' + sign(payload);
}
function isAdmin(req) {
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [payload, sig] = t.split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return false;
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp > Date.now(); } catch { return false; }
}

/* ---------- validation ---------- */
const STATUSES = ['available', 'pending', 'rented', 'draft'];
const TYPES = ['House', 'Townhome', 'Apartment', 'Condo', 'Duplex', 'Room'];
const PETS = ['No pets', 'Cats OK', 'Dogs OK', 'Cats and dogs OK'];
const UPLOAD_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const EXT_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const MAX_UPLOAD = 4.5 * 1024 * 1024; // serverless request bodies are capped at about 6 MB
const UPLOAD_URL = /^\/uploads\/([a-f0-9]+\.(?:jpg|png|webp|gif))$/;
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : 0; };

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
async function removeUploads(urls) {
  const names = urls.map((u) => UPLOAD_URL.exec(u)).filter(Boolean).map((m) => m[1]);
  await Promise.allSettled(names.map((n) => media().delete(n)));
}
const byNewest = (a, b) => String(b.createdAt).localeCompare(String(a.createdAt));

/* ---------- inquiries: one blob each, so simultaneous messages never overwrite each other ---------- */
async function inquiryKeys() {
  const { blobs } = await data().list({ prefix: 'inq/' });
  return blobs.map((b) => b.key).sort();
}
async function listInquiries() {
  const keys = (await inquiryKeys()).reverse().slice(0, 300);
  const items = await Promise.all(keys.map((k) => data().get(k, { type: 'json' })));
  return items.filter(Boolean);
}
async function findInquiryKey(id) {
  return (await inquiryKeys()).find((k) => k.endsWith('_' + id));
}

/* ---------- photos ---------- */
async function serveUpload(p, method) {
  const name = p.slice('/uploads/'.length);
  const m = /^[a-f0-9]+\.(jpg|png|webp|gif)$/.exec(name);
  if (!m || (method !== 'GET' && method !== 'HEAD')) return new Response('Not found', { status: 404 });
  const r = await media().getWithMetadata(name, { type: 'arrayBuffer' });
  if (!r) return new Response('Not found', { status: 404 });
  return new Response(method === 'HEAD' ? null : r.data, {
    status: 200,
    headers: {
      'content-type': (r.metadata && r.metadata.contentType) || EXT_TYPES[m[1]],
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}

/* ---------- API ---------- */
async function handleApi(req, context, p, m) {
  if (p === '/api/ping') return json(200, { ok: true });

  /* public */
  if (p === '/api/listings' && m === 'GET') {
    const list = (await getListings()).filter((l) => l.status === 'available' || l.status === 'pending').sort(byNewest);
    return json(200, list);
  }
  if (p === '/api/settings' && m === 'GET') return json(200, await getSettings());

  if (p === '/api/inquiries' && m === 'POST') {
    if (!(await allow('inq-' + ipKey(req, context), 10, 10 * 60 * 1000))) throw fail(429, 'Too many messages. Try again in a few minutes.');
    const b = await readJson(req);
    if (b.website) return json(200, { ok: true }); // honeypot field, bots fill it in
    const name = str(b.name, 80), email = str(b.email, 120), phone = str(b.phone, 40), message = str(b.message, 2000);
    if (!name || (!email && !phone) || !message) throw fail(400, 'Add your name, an email or phone number, and a message.');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail(400, 'That email address does not look right.');
    const l = (await getListings()).find((x) => x.id === b.listingId);
    const id = rid();
    const now = Date.now();
    await data().setJSON('inq/' + String(now).padStart(13, '0') + '_' + id, {
      id, name, email, phone, message,
      listingId: l ? l.id : '', listingTitle: l ? l.title : '',
      read: false, createdAt: new Date(now).toISOString(),
    });
    return json(200, { ok: true });
  }

  /* admin login */
  if (p === '/api/admin/login' && m === 'POST') {
    const rk = 'login-' + ipKey(req, context);
    if (!(await allow(rk, 8, 10 * 60 * 1000))) throw fail(429, 'Too many attempts. Wait a few minutes and try again.');
    const b = await readJson(req);
    if (!safeEqual(b.token || '', adminToken())) {
      await sleep(400);
      throw fail(401, 'That token is not right.');
    }
    await data().delete('rl/' + rk);
    return json(200, { session: makeSession() });
  }

  /* everything below needs a valid admin session */
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) throw fail(401, 'Your session ended. Sign in again.');

    if (p === '/api/admin/logout' && m === 'POST') return json(200, { ok: true });

    if (p === '/api/admin/listings' && m === 'GET') return json(200, (await getListings()).sort(byNewest));

    if (p === '/api/admin/listings' && m === 'POST') {
      const l = cleanListing(await readJson(req), null);
      if (!l.title) throw fail(400, 'Add a title for the listing.');
      if (!l.city) throw fail(400, 'Add the city.');
      const all = await getListings();
      all.unshift(l);
      await saveListings(all);
      return json(200, l);
    }

    let mm = /^\/api\/admin\/listings\/([a-f0-9]+)$/.exec(p);
    if (mm) {
      const all = await getListings();
      const i = all.findIndex((x) => x.id === mm[1]);
      if (i < 0) throw fail(404, 'That listing no longer exists.');
      if (m === 'PUT') {
        const l = cleanListing(await readJson(req), all[i]);
        if (!l.title) throw fail(400, 'Add a title for the listing.');
        if (!l.city) throw fail(400, 'Add the city.');
        const removed = all[i].images.filter((u) => !l.images.includes(u));
        all[i] = l;
        await saveListings(all);
        await removeUploads(removed);
        return json(200, l);
      }
      if (m === 'PATCH') {
        const b = await readJson(req);
        if (STATUSES.includes(b.status)) all[i].status = b.status;
        if (typeof b.featured === 'boolean') all[i].featured = b.featured;
        all[i].updatedAt = new Date().toISOString();
        await saveListings(all);
        return json(200, all[i]);
      }
      if (m === 'DELETE') {
        const [gone] = all.splice(i, 1);
        await saveListings(all);
        await removeUploads(gone.images);
        return json(200, { ok: true });
      }
    }

    if (p === '/api/admin/upload' && m === 'POST') {
      const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const ext = UPLOAD_TYPES[type];
      if (!ext) throw fail(400, 'Upload a JPG, PNG, WebP or GIF image.');
      if (Number(req.headers.get('content-length') || 0) > MAX_UPLOAD) throw fail(413, 'That photo is too large. The limit is about 4 MB.');
      const buf = await req.arrayBuffer();
      if (!buf.byteLength) throw fail(400, 'That file was empty.');
      if (buf.byteLength > MAX_UPLOAD) throw fail(413, 'That photo is too large. The limit is about 4 MB.');
      const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
      await media().set(name, buf, { metadata: { contentType: type } });
      return json(200, { url: '/uploads/' + name });
    }

    if (p === '/api/admin/inquiries' && m === 'GET') return json(200, await listInquiries());
    mm = /^\/api\/admin\/inquiries\/([a-f0-9]+)$/.exec(p);
    if (mm) {
      const key = await findInquiryKey(mm[1]);
      if (!key) throw fail(404, 'That message no longer exists.');
      if (m === 'PATCH') {
        const b = await readJson(req);
        const rec = await data().get(key, { type: 'json' });
        if (typeof b.read === 'boolean') rec.read = b.read;
        await data().setJSON(key, rec);
        return json(200, rec);
      }
      if (m === 'DELETE') { await data().delete(key); return json(200, { ok: true }); }
    }

    if (p === '/api/admin/settings' && m === 'GET') return json(200, await getSettings());
    if (p === '/api/admin/settings' && m === 'PUT') {
      const b = await readJson(req);
      const s = { phone: str(b.phone, 40), email: str(b.email, 120), address: str(b.address, 200), hours: str(b.hours, 120) };
      await data().setJSON('settings', s);
      return json(200, s);
    }
  }
  throw fail(404, 'Not found.');
}

/* ---------- entry point ---------- */
export default async (req, context) => {
  try {
    const p = new URL(req.url).pathname;
    if (p.startsWith('/uploads/')) return await serveUpload(p, req.method);
    return await handleApi(req, context, p, req.method);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(e);
    return json(500, { error: 'Something went wrong on the server.' });
  }
};
