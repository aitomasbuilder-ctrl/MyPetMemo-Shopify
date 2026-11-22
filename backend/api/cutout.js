'use strict';
// POST /api/cutout — removes the background from the shopper's own photo.
// The picture is not redrawn.
//
// BiRefNet-general-lite cannot run here. Its ONNX file is 214 MB with a fixed
// 1024×1024 input. On the production WASM runtime (onnxruntime-web, one thread)
// the session itself fits in about 1 GB, then the first forward pass is killed
// at a 2048 MB cap — Vercel reports FUNCTION_INVOCATION_FAILED, including for a
// 64×64 JPEG, because the network never sees the original photo size. Turning
// the memory arena off and disabling graph optimisation still dies at 2048 MB.
// Published runs of this same export peak at several gigabytes, past any
// Vercel function size.
//
// The route therefore uses the bundled U^2-Net portable model (u2netp, 4.5 MB,
// Apache-2.0) at 320×320. A measured run stays under about 400 MB. CUTOUT_MODEL_URL
// is not read: a Blob URL of the 214 MB file must not be loaded again.
// Each cut-out is cached in Blob under the photo's sha256.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { cors, send, limiter, clientIp } = require('../lib/http');
const { trimAlpha } = require('../lib/alpha-trim');

const MAX_UPLOAD = 15 * 1024 * 1024;
const MODEL_FILE = path.join(__dirname, '..', 'models', 'u2netp.onnx');
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
const release = t => { try { if (t && typeof t.dispose === 'function') t.dispose(); } catch { /* already freed */ } };

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

function wasmSession(modelPath) {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = require('onnxruntime-web/wasm');
      const dist = path.dirname(require.resolve('onnxruntime-web/wasm')) + path.sep;
      ort.env.wasm.wasmPaths = dist;
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      const bytes = fs.readFileSync(modelPath);
      return ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
        intraOpNumThreads: 1,
        interOpNumThreads: 1
      });
    })().catch(err => { sessionPromise = null; throw err; });
  }
  return sessionPromise;
}

/** Fixed H×W of the bundled network. A 1024 input (BiRefNet) is refused. */
function networkSize(session) {
  const name = session.inputNames[0];
  const meta = (session.inputMetadata || []).find(m => m.name === name) || (session.inputMetadata || [])[0];
  const shape = meta && meta.shape;
  const h = shape && Number(shape[2]);
  const w = shape && Number(shape[3]);
  if (h > 0 && w > 0 && h <= 512 && w <= 512) return { h, w };
  throw Object.assign(new Error('The cut-out model is too large to run here.'), { status: 503, code: 'cutout_model_too_large' });
}

/** Nearest-size grey mask. Sharp otherwise expands a one-channel resize into RGB and the matte becomes stripes. */
async function upsampleMatte(small, sw, sh, dw, dh) {
  const up = await sharp(small, { raw: { width: sw, height: sh, channels: 1 } })
    .resize(dw, dh, { fit: 'fill' }).toColourspace('b-w').raw().toBuffer();
  if (up.length !== dw * dh) throw new Error('matte_channels');
  return up;
}

async function inferMatte(image, { modelPath = MODEL_FILE } = {}) {
  const session = await wasmSession(modelPath);
  const { h: sizeH, w: sizeW } = networkSize(session);
  const meta = await sharp(image).metadata();
  const { data } = await sharp(image).resize(sizeW, sizeH, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const input = new Float32Array(3 * sizeH * sizeW);
  const plane = sizeH * sizeW;
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) input[c * plane + i] = (data[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  }
  const ort = require('onnxruntime-web/wasm');
  const name = session.inputNames[0];
  const tensor = new ort.Tensor('float32', input, [1, 3, sizeH, sizeW]);
  const res = await session.run({ [name]: tensor });
  const outName = session.outputNames[0];
  const raw = res[outName].data;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < plane; i++) { const v = raw[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const logits = lo < -0.01 || hi > 1.01;
  const prob = new Float32Array(plane);
  let pLo = Infinity, pHi = -Infinity;
  for (let i = 0; i < plane; i++) {
    let p = raw[i];
    if (logits) p = 1 / (1 + Math.exp(-p));
    prob[i] = p;
    if (p < pLo) pLo = p;
    if (p > pHi) pHi = p;
  }
  release(tensor);
  for (const key of Object.keys(res)) release(res[key]);
  const span = pHi - pLo || 1;
  const small = Buffer.alloc(plane);
  for (let i = 0; i < plane; i++) small[i] = Math.round(Math.min(1, Math.max(0, (prob[i] - pLo) / span)) * 255);
  const up = await upsampleMatte(small, sizeW, sizeH, meta.width, meta.height);
  const soft = new Float32Array(meta.width * meta.height);
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
  const modelPath = deps.modelPath || MODEL_FILE;
  if (!deps.infer && !fs.existsSync(modelPath)) return send(res, 503, { code: 'cutout_not_configured', message: 'The cut-out service isn’t connected yet. Please try again later.' });
  try {
    const image = deps.image || await readPhoto(req);
    const sha = sha256(image);
    const fetchImpl = deps.fetchImpl || fetch;
    const cacheGet = deps.cacheGet || (s => blobGet(s, fetchImpl));
    const hit = await cacheGet(sha);
    if (hit) return send(res, 200, { image: `data:image/png;base64,${hit.png.toString('base64')}`, url: hit.url, sha256: sha, cached: true });
    const soft = await (deps.infer || inferMatte)(image, { modelPath });
    const png = await trimAlpha(await applyMatte(image, soft));
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
module.exports.inferMatte = inferMatte;
module.exports.upsampleMatte = upsampleMatte;
module.exports.MODEL_FILE = MODEL_FILE;
