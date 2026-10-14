'use strict';
// POST /api/portrait — the pet studio's "Portrait generation URL".
// Body: multipart form with `image` (the shopper's pet photo); `product`, `shape` and `style` are accepted and ignored.
// Response: { image: data URL of the vector portrait on flat green, background: 'chroma' }.
const sharp = require('sharp');
const { generatePortrait, PortraitError } = require('../lib/portrait-ai');
const { cors, send, limiter, clientIp } = require('../lib/http');

const MAX_UPLOAD = 15 * 1024 * 1024;
const allow = limiter({ max: Number(process.env.PORTRAITS_PER_HOUR || 20), windowMs: 3600e3 });

async function readPhoto(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_UPLOAD) throw new PortraitError('too_large', 'That photo is too large. Please choose a smaller one.', 413); chunks.push(c); }
  let form;
  try {
    form = await new Request('http://local/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] || '' }, body: Buffer.concat(chunks) }).formData();
  } catch { throw new PortraitError('bad_request', 'That photo couldn’t be processed. Please try a different one.', 400); }
  const file = form.get('image');
  if (!file || typeof file.arrayBuffer !== 'function') throw new PortraitError('bad_request', 'Please choose a photo of your pet.', 400);
  // Re-encode: checks it really is an image, applies phone rotation and keeps the AI request small.
  try {
    const image = await sharp(Buffer.from(await file.arrayBuffer())).rotate().resize(1536, 1536, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
    return { image, mimeType: 'image/jpeg' };
  } catch { throw new PortraitError('bad_image', 'That photo couldn’t be processed. Please try a different one.', 400); }
}

async function handler(req, res, deps = {}) {
  if (!cors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  if (!allow(clientIp(req))) return send(res, 429, { code: 'rate_limited', message: 'You’ve made a lot of portraits in a short time. Please wait a little and try again.' });
  try {
    const photo = await readPhoto(req);
    const art = await (deps.generate || generatePortrait)(photo);
    const png = await sharp(art.image).png().toBuffer();
    return send(res, 200, { image: `data:image/png;base64,${png.toString('base64')}`, background: 'chroma' });
  } catch (err) {
    if (err instanceof PortraitError) return send(res, err.status, { code: err.code, message: err.message });
    console.error('portrait failed', err);
    return send(res, 500, { code: 'server_error', message: 'Our portrait service had a hiccup. Please try again.' });
  }
}
module.exports = handler;
