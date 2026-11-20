'use strict';
// Print-time artwork upscaler: Real-ESRGAN General x4v3 (BSD-3, models/README.md), run on one
// WebAssembly thread (onnxruntime-web). No API and no per-image cost.
// A scene is about 864×1184 px and a 50×60 blanket prints at 7875×9375, so lanczos otherwise
// enlarges it ~9×. This model does ×4 and the renderer scales the rest (~2.3×).
//
// Off unless UPSCALE_ARTWORK=on (or "1"). One full scene is about a minute and a half of
// single-thread WASM on a fast core, and the order function also has to render and upload
// inside maxDuration 300s. UPSCALE_ARTWORK=off still forces it off. Any failure, including
// running past `deadline`, returns the original artwork so fulfilment still prints.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const SCALE = 4, TILE = 256, PAD = 12;
const MODEL = () => process.env.UPSCALE_MODEL || path.join(__dirname, '..', 'models', 'realesr-general-x4v3.onnx');
let ort = null, sessionPromise = null;

function wantUpscale(explicit) {
  if (typeof explicit === 'boolean') return explicit;
  const v = String(process.env.UPSCALE_ARTWORK || '').trim().toLowerCase();
  return v === 'on' || v === '1';
}

function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      ort = ort || require('onnxruntime-web/wasm');
      // Absolute directory so the WASM file is found when the function cwd is not the package.
      const dist = path.dirname(require.resolve('onnxruntime-web/wasm')) + path.sep;
      ort.env.wasm.wasmPaths = dist;
      ort.env.wasm.numThreads = Number(process.env.UPSCALE_THREADS || 1);
      ort.env.wasm.proxy = false;
      return ort.InferenceSession.create(fs.readFileSync(MODEL()), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });
    })().catch(err => { sessionPromise = null; throw err; });
  }
  return sessionPromise;
}

const release = t => { try { if (t && typeof t.dispose === 'function') t.dispose(); } catch { /* already freed */ } };

/** RGB buffer (w*h*3) -> ×4 RGB buffer. Tiles keep PAD px of context so seams don't show. */
async function upscaleRgb(rgb, w, h, deadline) {
  const s = await getSession();
  const W = w * SCALE, H = h * SCALE, out = Buffer.alloc(W * H * 3);
  for (let ty = 0; ty < h; ty += TILE) for (let tx = 0; tx < w; tx += TILE) {
    if (deadline && Date.now() > deadline) throw Object.assign(new Error('budget'), { code: 'budget' });
    const x0 = Math.max(0, tx - PAD), y0 = Math.max(0, ty - PAD);
    const x1 = Math.min(w, tx + TILE + PAD), y1 = Math.min(h, ty + TILE + PAD);
    const tw = x1 - x0, th = y1 - y0, n = tw * th;
    const input = new Float32Array(3 * n);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const si = ((y0 + y) * w + (x0 + x)) * 3, di = y * tw + x;
      input[di] = rgb[si] / 255; input[n + di] = rgb[si + 1] / 255; input[2 * n + di] = rgb[si + 2] / 255;
    }
    const tensor = new ort.Tensor('float32', input, [1, 3, th, tw]);
    const res = await s.run({ input: tensor });
    const o = res.output;
    const dims = o && o.dims;
    const OW = tw * SCALE, OH = th * SCALE, ON = OW * OH;
    if (!o || !dims || dims[0] !== 1 || dims[1] !== 3 || dims[2] !== OH || dims[3] !== OW) {
      release(tensor); release(o);
      throw new Error(`unexpected_output:${dims && dims.join('x')}`);
    }
    const data = o.data;
    const cx0 = (tx - x0) * SCALE, cy0 = (ty - y0) * SCALE;
    const cw = Math.min(TILE, w - tx) * SCALE, ch = Math.min(TILE, h - ty) * SCALE;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const si = (cy0 + y) * OW + (cx0 + x), di = ((ty * SCALE + y) * W + (tx * SCALE + x)) * 3;
      for (let c = 0; c < 3; c++) { const v = data[c * ON + si] * 255; out[di + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }
    }
    release(tensor); release(o);
  }
  return { data: out, width: W, height: H };
}

/**
 * Upscales artwork ×4 when it will be printed at least `minRatio` times larger than it is.
 * `printedWidth` is the pet's width on the print file in px. Alpha (cut-out pets) is enlarged with lanczos3.
 * Returns { buffer, upscaled, info }.
 */
async function upscaleArtwork(buf, { printedWidth, minRatio = 1.5, maxPixels = 2.5e6, log = () => {}, enabled, deadline } = {}) {
  if (!wantUpscale(enabled)) return { buffer: buf, upscaled: false, info: 'disabled' };
  if (deadline && Date.now() > deadline) return { buffer: buf, upscaled: false, info: 'budget' };
  let meta;
  try { meta = await sharp(buf).metadata(); } catch (e) { return { buffer: buf, upscaled: false, info: 'unreadable' }; }
  if (!(meta.width > 0) || !(printedWidth > 0) || printedWidth / meta.width < minRatio) return { buffer: buf, upscaled: false, info: 'not_needed' };
  if (meta.width * meta.height > maxPixels) return { buffer: buf, upscaled: false, info: 'too_large' };
  // Measured ~0.08 ms/px on one fast core; 0.12 leaves room for tile overlap and a slower vCPU.
  // Skip before loading the model when this image cannot finish inside the order's remaining budget.
  const estimateMs = meta.width * meta.height * Number(process.env.UPSCALE_MS_PER_PIXEL || 0.12);
  if (deadline && Date.now() + estimateMs > deadline) return { buffer: buf, upscaled: false, info: 'budget' };
  try {
    const t0 = Date.now();
    const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) throw new Error(`expected_rgb:${info.channels}`);
    const up = await upscaleRgb(data, info.width, info.height, deadline);
    let img = sharp(up.data, { raw: { width: up.width, height: up.height, channels: 3 } });
    if (meta.hasAlpha) {
      const alpha = await sharp(buf).extractChannel('alpha').resize(up.width, up.height, { kernel: 'lanczos3' }).raw().toBuffer();
      const rgba = Buffer.alloc(up.width * up.height * 4);
      for (let i = 0, j = 0, k = 0; i < up.width * up.height; i++) { rgba[j++] = up.data[k++]; rgba[j++] = up.data[k++]; rgba[j++] = up.data[k++]; rgba[j++] = alpha[i]; }
      img = sharp(rgba, { raw: { width: up.width, height: up.height, channels: 4 } });
    }
    const buffer = await img.png({ compressionLevel: 3 }).toBuffer();
    const result = { model: 'realesr-general-x4v3', from: `${meta.width}x${meta.height}`, to: `${up.width}x${up.height}`, ms: Date.now() - t0 };
    log(result);
    return { buffer, upscaled: true, info: result };
  } catch (e) {
    if (e && e.code === 'budget') return { buffer: buf, upscaled: false, info: 'budget' };
    log({ upscale_failed: String((e && e.message) || e) });
    return { buffer: buf, upscaled: false, info: 'failed' };
  }
}

module.exports = { upscaleArtwork, upscaleRgb, wantUpscale };
