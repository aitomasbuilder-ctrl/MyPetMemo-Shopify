'use strict';
// POST /api/cutout — removes the background from the shopper's own photo.
// The picture is not redrawn. BiRefNet-general-lite (MIT) runs once per photo;
// the model is too large to ship in the function, so CUTOUT_MODEL_URL points at
// a Vercel Blob copy that is downloaded into /tmp on a cold start. The cut-out
// is cached in Blob under the photo's sha256.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { cors, send, limiter, clientIp } = require('../lib/http');

const MAX_UPLOAD = 15 * 1024 * 1024;
const MODEL_FILE = path.join('/tmp', 'birefnet-general-lite.onnx');
const INPUT_SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const allow = limiter({ max: Number(process.env.CUTOUTS_PER_HOUR || 20), windowMs: 3600e3 });

let sessionPromise = null;

function hardenAlpha(a) {
  const x = (a - 0.30) / 0.40;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Pull the backdrop colour out of the fur fringe, then apply the hardened matte. */
function cleanEdges(rgb, width, height, soft) {
  let br = 0, bg = 0, bb = 0, bn = 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    if (soft[i] < 0.15) { br += rgb[i * 3]; bg += rgb[i * 3 + 1]; bb += rgb[i * 3 + 2]; bn++; }
  }
  if (!bn) { br = bg = bb = 255; bn = 1; }
  br /= bn; bg /= bn; bb /= bn;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const a = soft[i];
    const hard = hardenAlpha(a);
    let r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    if (a > 0.02 && a < 0.98) {
      r = (r - (1 - a) * br) / a; g = (g - (1 - a) * bg) / a; b = (b - (1 - a) * bb) / a;
    }
    const clamp = v => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    out[i * 4] = clamp(r); out[i * 4 + 1] = clamp(g); out[i * 4 + 2] = clamp(b); out[i * 4 + 3] = Math.round(hard * 255);
  }
  return out;
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function readPhoto(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_UPLOAD) { const e = new Error('That photo is too large. Please choose a smaller one.'); e.status = 413; e.code = 'too_large'; throw e; } chunks.push(c); }
  let form;
  try {
    form = await new Request('http://local/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] || '' }, body: Buffer.concat(chunks) }).formData();
  } catch { const e = new Error('That photo couldn’t be processed. Please try a different one.'); e.status = 400; e.code = 'bad_request'; throw e; }
  const file = form.get('image');
  if (!file || typeof file.arrayBuffer !== 'function') { const e = new Error('Please choose a photo of your pet.'); e.status = 400; e.code = 'bad_request'; throw e; }
  try {
    const image = await sharp(Buffer.from(await file.arrayBuffer())).rotate().resize(2000, 2000, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    return image;
  } catch { const e = new Error('That photo couldn’t be processed. Please try a different one.'); e.status = 400; e.code = 'bad_image'; throw e; }
}

async function downloadModel(url, fetchImpl) {
  if (fs.existsSync(MODEL_FILE) && fs.statSync(MODEL_FILE).size > 0) return MODEL_FILE;
  const res = await fetchImpl(url);
  if (!res.ok) throw Object.assign(new Error('The cut-out model could not be downloaded.'), { status: 502, code: 'cutout_model_unavailable' });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(MODEL_FILE, buf);
  return MODEL_FILE;
}

async function wasmSession(modelUrl, fetchImpl) {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const file = await downloadModel(modelUrl, fetchImpl);
      const ort = require('onnxruntime-web/wasm');
      const dist = path.dirname(require.resolve('onnxruntime-web/wasm')) + path.sep;
      ort.env.wasm.wasmPaths = dist;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      return ort.InferenceSession.create(fs.readFileSync(file), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    })().catch(err => { sessionPromise = null; throw err; });
  }
  return sessionPromise;
}

async function inferMatte(image, { modelUrl, fetchImpl = fetch }) {
  const session = await wasmSession(modelUrl, fetchImpl);
  const meta = await sharp(image).metadata();
  const size = INPUT_SIZE;
  const { data } = await sharp(image).resize(size, size, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const input = new Float32Array(3 * size * size);
  for (let i = 0; i < size * size; i++) {
    for (let c = 0; c < 3; c++) input[c * size * size + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  const ort = require('onnxruntime-web/wasm');
  const name = session.inputNames[0];
  const res = await session.run({ [name]: new ort.Tensor('float32', input, [1, 3, size, size]) });
  const outName = session.outputNames[0];
  const raw = res[outName].data;
  const soft = new Float32Array(meta.width * meta.height);
  const plane = size * size;
  // The network may return logits or a probability. Map either into 0..1 at the photo's size.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < plane; i++) { const v = raw[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const logits = lo < 0 || hi > 1;
  const small = Buffer.alloc(plane);
  for (let i = 0; i < plane; i++) {
    let p = raw[i];
    if (logits) p = 1 / (1 + Math.exp(-p));
    small[i] = Math.round(Math.min(1, Math.max(0, p)) * 255);
  }
  const up = await sharp(small, { raw: { width: size, height: size, channels: 1 } }).resize(meta.width, meta.height, { fit: 'fill' }).raw().toBuffer();
  for (let i = 0; i < soft.length; i++) soft[i] = up[i] / 255;
  return soft;
}

async function applyMatte(image, soft) {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = cleanEdges(data, info.width, info.height, soft);
  return sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

async function blobGet(sha, fetchImpl) {
  const { list } = require('@vercel/blob');
  const found = await list({ prefix: `cutouts/${sha}.png` });
  const blob = (found.blobs || []).find(b => b.pathname === `cutouts/${sha}.png`);
  if (!blob) return null;
  const res = await fetchImpl(blob.url);
  if (!res.ok) return null;
  return { png: Buffer.from(await res.arrayBuffer()), url: blob.url, sha256: sha, cached: true };
}

async function blobPut(sha, png) {
  const { put } = require('@vercel/blob');
  const blob = await put(`cutouts/${sha}.png`, png, { access: 'public', contentType: 'image/png', addRandomSuffix: false, allowOverwrite: true });
  return blob.url;
}

async function handler(req, res, deps = {}) {
  if (!cors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  if (!(deps.allow || allow)(clientIp(req))) return send(res, 429, { code: 'rate_limited', message: 'You’ve made a lot of cut-outs in a short time. Please wait a little and try again.' });
  const modelUrl = deps.modelUrl || process.env.CUTOUT_MODEL_URL;
  if (!modelUrl) return send(res, 503, { code: 'cutout_not_configured', message: 'The cut-out service isn’t connected yet. Please try again later.' });
  try {
    const image = deps.image || await readPhoto(req);
    const sha = sha256(image);
    const fetchImpl = deps.fetchImpl || fetch;
    const cacheGet = deps.cacheGet || (s => blobGet(s, fetchImpl));
    const hit = await cacheGet(sha);
    if (hit) return send(res, 200, { image: `data:image/png;base64,${hit.png.toString('base64')}`, url: hit.url, sha256: sha, cached: true });
    const soft = await (deps.infer || inferMatte)(image, { modelUrl, fetchImpl });
    const png = await applyMatte(image, soft);
    const cachePut = deps.cachePut || blobPut;
    const url = await cachePut(sha, png);
    return send(res, 200, { image: `data:image/png;base64,${png.toString('base64')}`, url, sha256: sha, cached: false });
  } catch (err) {
    if (err && err.status) return send(res, err.status, { code: err.code || 'bad_request', message: err.message });
    console.error('cutout failed', err);
    return send(res, 500, { code: 'server_error', message: 'The cut-out service had a hiccup. Please try again.' });
  }
}

module.exports = handler;
module.exports.hardenAlpha = hardenAlpha;
module.exports.cleanEdges = cleanEdges;
module.exports.applyMatte = applyMatte;
