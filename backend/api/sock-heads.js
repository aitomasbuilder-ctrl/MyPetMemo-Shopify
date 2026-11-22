'use strict';
// POST /api/sock-heads — one pet photo in, one sticker head out.
// Uses the same bundled cut-out as /api/cutout, then keeps the head and draws the
// white sticker outline. The print files are not built here. They are rendered
// from these heads after the order is paid.
const crypto = require('node:crypto');
const fs = require('node:fs');
const sharp = require('sharp');
const { cors, send, limiter, clientIp } = require('../lib/http');
const { inferMatte, applyMatte, MODEL_FILE } = require('./cutout');
const { trimAlpha } = require('../lib/alpha-trim');
const { prepareHead } = require('../lib/sock-render');

const MAX_UPLOAD = 15 * 1024 * 1024;
const allow = limiter({ max: Number(process.env.SOCK_HEADS_PER_HOUR || 40), windowMs: 3600e3 });
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function readPhoto(req) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_UPLOAD) {
      const e = new Error('That photo is too large. Please choose a smaller one.');
      e.status = 413; e.code = 'too_large'; throw e;
    }
    chunks.push(c);
  }
  let form;
  try {
    form = await new Request('http://local/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] || '' }, body: Buffer.concat(chunks) }).formData();
  } catch { const e = new Error('That photo couldn’t be processed. Please try a different one.'); e.status = 400; e.code = 'bad_request'; throw e; }
  const file = form.get('image');
  if (!file || typeof file.arrayBuffer !== 'function') {
    const e = new Error('Please choose a photo of your pet.');
    e.status = 400; e.code = 'bad_request'; throw e;
  }
  try {
    return await sharp(Buffer.from(await file.arrayBuffer())).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch { const e = new Error('That photo couldn’t be processed. Please try a different one.'); e.status = 400; e.code = 'bad_image'; throw e; }
}

async function blobGet(key, fetchImpl) {
  const { list } = require('@vercel/blob');
  const found = await list({ prefix: `sock-heads/${key}.png` });
  const blob = (found.blobs || []).find(b => b.pathname === `sock-heads/${key}.png`);
  if (!blob) return null;
  const res = await fetchImpl(blob.url);
  if (!res.ok) return null;
  const png = Buffer.from(await res.arrayBuffer());
  return { png, url: blob.url, sha256: sha256(png), cached: true };
}

async function blobPut(key, png) {
  const { put } = require('@vercel/blob');
  const blob = await put(`sock-heads/${key}.png`, png, { access: 'public', contentType: 'image/png', addRandomSuffix: false, allowOverwrite: true });
  return blob.url;
}

async function handler(req, res, deps = {}) {
  if (!cors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  if (!(deps.allow || allow)(clientIp(req))) return send(res, 429, { code: 'rate_limited', message: 'You’ve made a lot of cut-outs in a short time. Please wait a little and try again.' });
  const modelPath = deps.modelPath || MODEL_FILE;
  if (!deps.infer && !fs.existsSync(modelPath)) return send(res, 503, { code: 'cutout_not_configured', message: 'The cut-out service isn’t connected yet. Please try again later.' });
  try {
    const image = deps.image || await readPhoto(req);
    const sourceSha = sha256(image);
    const fetchImpl = deps.fetchImpl || fetch;
    const cacheGet = deps.cacheGet || (key => blobGet(key, fetchImpl));
    const hit = await cacheGet(sourceSha);
    if (hit) return send(res, 200, { image: `data:image/png;base64,${hit.png.toString('base64')}`, url: hit.url, sha256: hit.sha256, cached: true });
    const soft = await (deps.infer || inferMatte)(image, { modelPath });
    const cut = await trimAlpha(await applyMatte(image, soft));
    const png = await (deps.finish || prepareHead)(cut);
    const fileSha = sha256(png);
    const cachePut = deps.cachePut || blobPut;
    const url = await cachePut(sourceSha, png);
    return send(res, 200, { image: `data:image/png;base64,${png.toString('base64')}`, url, sha256: fileSha, cached: false });
  } catch (err) {
    if (err && err.status) return send(res, err.status, { code: err.code || 'bad_request', message: err.message });
    console.error('sock-heads failed', err);
    return send(res, 500, { code: 'server_error', message: 'The cut-out service had a hiccup. Please try again.' });
  }
}

module.exports = handler;
