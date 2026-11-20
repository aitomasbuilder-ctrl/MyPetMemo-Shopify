'use strict';
// Print-time artwork upscaler: Real-ESRGAN General x4v3 (BSD-3, models/README.md), run on the CPU with
// onnxruntime-web's WebAssembly build (small enough for a Vercel function; no API, no per-image cost).
// The AI artwork is ~864×1184 px but a 50×60 blanket prints at 7875×9375 px, so without this it is
// enlarged ~9× with lanczos3. With it: ×4 by the model, then the renderer scales the rest (~2.3×).
// Fail-open: any problem returns the original artwork, so fulfilment never stops because of the upscaler.
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const SCALE = 4, TILE = 256, PAD = 12;
const MODEL = () => process.env.UPSCALE_MODEL || path.join(__dirname, '..', 'models', 'realesr-general-x4v3.onnx');
let ort = null, session = null;

async function getSession() {
  if (!session) {
    ort = ort || require('onnxruntime-web/wasm');
    ort.env.wasm.numThreads = Number(process.env.UPSCALE_THREADS || 1);
    session = await ort.InferenceSession.create(fs.readFileSync(MODEL()), { graphOptimizationLevel: 'all' });
  }
  return session;
}

/** RGB buffer (w*h*3) -> ×4 RGB buffer. Tiles run with PAD px of context so seams don't show. */
async function upscaleRgb(rgb, w, h) {
  const s = await getSession();
  const W = w * SCALE, H = h * SCALE, out = Buffer.alloc(W * H * 3);
  for (let ty = 0; ty < h; ty += TILE) for (let tx = 0; tx < w; tx += TILE) {
    const x0 = Math.max(0, tx - PAD), y0 = Math.max(0, ty - PAD);
    const x1 = Math.min(w, tx + TILE + PAD), y1 = Math.min(h, ty + TILE + PAD);
    const tw = x1 - x0, th = y1 - y0, n = tw * th;
    const input = new Float32Array(3 * n);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const si = ((y0 + y) * w + (x0 + x)) * 3, di = y * tw + x;
      input[di] = rgb[si] / 255; input[n + di] = rgb[si + 1] / 255; input[2 * n + di] = rgb[si + 2] / 255;
    }
    const res = await s.run({ input: new ort.Tensor('float32', input, [1, 3, th, tw]) });
    const o = res.output.data, OW = tw * SCALE, ON = OW * th * SCALE;
    const cx0 = (tx - x0) * SCALE, cy0 = (ty - y0) * SCALE;
    const cw = Math.min(TILE, w - tx) * SCALE, ch = Math.min(TILE, h - ty) * SCALE;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const si = (cy0 + y) * OW + (cx0 + x), di = ((ty * SCALE + y) * W + (tx * SCALE + x)) * 3;
      for (let c = 0; c < 3; c++) { const v = o[c * ON + si] * 255; out[di + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }
    }
  }
  return { data: out, width: W, height: H };
}

/**
 * Upscales artwork ×4 when it will be printed at least `minRatio` times larger than it is.
 * `printedWidth` = the pet's width on the print file in px. Alpha (cut-out pets) is enlarged with lanczos3.
 * Returns { buffer, upscaled, info }.
 */
async function upscaleArtwork(buf, { printedWidth, minRatio = 1.5, maxPixels = 2.5e6, log = () => {} } = {}) {
  if (process.env.UPSCALE_ARTWORK === 'off') return { buffer: buf, upscaled: false, info: 'disabled' };
  let meta;
  try { meta = await sharp(buf).metadata(); } catch (e) { return { buffer: buf, upscaled: false, info: 'unreadable' }; }
  if (!(printedWidth > 0) || printedWidth / meta.width < minRatio) return { buffer: buf, upscaled: false, info: 'not_needed' };
  if (meta.width * meta.height > maxPixels) return { buffer: buf, upscaled: false, info: 'too_large' };
  try {
    const t0 = Date.now();
    const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const up = await upscaleRgb(data, info.width, info.height);
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
    log({ upscale_failed: String((e && e.message) || e) });
    return { buffer: buf, upscaled: false, info: 'failed' };
  }
}

module.exports = { upscaleArtwork, upscaleRgb };
