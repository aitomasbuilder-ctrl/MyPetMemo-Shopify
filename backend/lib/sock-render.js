'use strict';
// Turns cut-out pet photos into the sticker heads and the two sock print files.
// The 1417×4252 files are built only when a paid order is fulfilled. The upload
// step stops at the sticker head, which is what the product-page preview draws.
const sharp = require('sharp');
const pattern = require('../shared/sock-pattern');
const { trimAlpha } = require('./alpha-trim');

const SOCK_W = pattern.SOCK_W;
const SOCK_H = pattern.SOCK_H;

function hex(color) {
  const n = parseInt(String(color).replace('#', ''), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha: 1 };
}

async function raw(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, c: info.channels };
}

/** A standing pet becomes the head (ears included). A photo that is already a face is kept. */
async function cropHead(png) {
  const { data, w, h, c } = await raw(png);
  if (h < w * 1.22) return png;
  const widths = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let min = w, max = -1;
    const row = y * w * c;
    for (let x = 0; x < w; x++) {
      if (data[row + x * c + 3] > 24) {
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
    widths[y] = max < 0 ? 0 : max - min + 1;
  }
  const rad = Math.max(2, Math.round(h * 0.02));
  const sm = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0, n = 0;
    for (let k = -rad; k <= rad; k++) {
      const yy = y + k;
      if (yy >= 0 && yy < h) { s += widths[yy]; n++; }
    }
    sm[y] = n ? s / n : 0;
  }
  let topMax = 1;
  const topEnd = Math.max(1, Math.round(h * 0.42));
  for (let y = 0; y < topEnd; y++) if (sm[y] > topMax) topMax = sm[y];
  const thresh = topMax * 0.68;
  let neck = -1;
  const from = Math.round(h * 0.26);
  const to = Math.round(h * 0.70);
  for (let y = from; y < to - 1; y++) {
    if (sm[y] < thresh && sm[y] <= sm[y - 1] && sm[y] <= sm[Math.min(h - 1, y + 1)]) { neck = y; break; }
  }
  if (neck < 0) {
    if (h < w * 1.55) return png;
    neck = Math.round(Math.min(h * 0.48, w * 1.15));
  }
  let bottom = Math.min(h - 1, neck + Math.round(w * 0.06));
  bottom = Math.max(bottom, Math.round(Math.min(w * 1.05, h - 1)));
  if (bottom > h * 0.92) return png;
  const cropped = await sharp(png).extract({ left: 0, top: 0, width: w, height: bottom + 1 }).png().toBuffer();
  return trimAlpha(cropped);
}

/** Square dilation. A blur fills the gaps between ears; this stays a ring. */
function dilateAlpha(alpha, w, h, radius) {
  const tmp = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      for (let xx = x0; xx <= x1; xx++) if (alpha[row + xx] > m) m = alpha[row + xx];
      tmp[row + x] = m;
    }
  }
  const out = Buffer.alloc(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(h - 1, y + radius);
      for (let yy = y0; yy <= y1; yy++) if (tmp[yy * w + x] > m) m = tmp[yy * w + x];
      out[y * w + x] = m;
    }
  }
  return out;
}

/** White sticker ring around the fur. Padding comes first: a trimmed cut-out has no room outside the ears. */
async function stickerOutline(png, { ratio = 0.022 } = {}) {
  const src = await raw(png);
  let opaque = 0;
  for (let i = 3; i < src.data.length; i += src.c) if (src.data[i] > 20) opaque++;
  if (opaque < 30) {
    const err = new Error('We couldn’t find a pet in that photo. Please use a clear photo of the face.');
    err.status = 422;
    err.code = 'pet_not_found';
    throw err;
  }
  const radius = Math.max(3, Math.round(Math.min(src.w, src.h) * ratio));
  const pad = radius + 2;
  const w = src.w + pad * 2;
  const h = src.h + pad * 2;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < src.h; y++) {
    src.data.copy(data, ((y + pad) * w + pad) * 4, y * src.w * src.c, (y + 1) * src.w * src.c);
  }
  const alpha = Buffer.alloc(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3];
  const grown = dilateAlpha(alpha, w, h, radius);
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3];
    if (a > 16) {
      out[i * 4] = data[i * 4];
      out[i * 4 + 1] = data[i * 4 + 1];
      out[i * 4 + 2] = data[i * 4 + 2];
      out[i * 4 + 3] = a;
    } else if (grown[i] > 40) {
      out[i * 4] = 255; out[i * 4 + 1] = 255; out[i * 4 + 2] = 255; out[i * 4 + 3] = 255;
    }
  }
  return trimAlpha(await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer());
}

async function prepareHead(cutoutPng) {
  return stickerOutline(await cropHead(cutoutPng));
}

function decoSvg(kind, size, tint) {
  const s = Math.max(8, Math.round(size));
  const fill = pattern.TINTS[tint] || pattern.TINTS[0];
  if (kind === 'heart') {
    return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 100 100"><path fill="${fill}" d="M50 88C50 88 8 58 8 36C8 18 24 8 38 16C44 20 50 28 50 28C50 28 56 20 62 16C76 8 92 18 92 36C92 58 50 88 50 88Z"/></svg>`);
  }
  const e = ([cx, cy, rx, ry]) => `<ellipse cx="${(cx * 100).toFixed(1)}" cy="${(cy * 100).toFixed(1)}" rx="${(rx * 100).toFixed(1)}" ry="${(ry * 100).toFixed(1)}" fill="${fill}"/>`;
  const toes = pattern.PAW.toes.map(e).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 100 100">${toes}${e(pattern.PAW.pad)}</svg>`);
}

async function sprite(input, box, angle) {
  const fitted = await sharp(input).rotate().resize(Math.max(1, Math.round(box)), Math.max(1, Math.round(box)), {
    fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 }
  }).png().toBuffer();
  if (!angle) return fitted;
  return sharp(fitted).rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

async function clipped(spriteBuf, cx, cy, W, H) {
  const meta = await sharp(spriteBuf).metadata();
  let left = Math.round(cx - meta.width / 2);
  let top = Math.round(cy - meta.height / 2);
  let sx = 0, sy = 0, w = meta.width, h = meta.height;
  if (left < 0) { sx = -left; w += left; left = 0; }
  if (top < 0) { sy = -top; h += top; top = 0; }
  if (left >= W || top >= H || w < 1 || h < 1) return null;
  if (left + w > W) w = W - left;
  if (top + h > H) h = H - top;
  if (w < 1 || h < 1) return null;
  let input = spriteBuf;
  if (sx || sy || w !== meta.width || h !== meta.height) {
    input = await sharp(spriteBuf).extract({ left: sx, top: sy, width: w, height: h }).png().toBuffer();
  }
  return { input, left, top };
}

/**
 * One print file. `pets` are sticker-head PNGs, already checked against the approved hashes.
 * `side` is "left" or "right".
 */
async function renderSock({ pets, side = 'left', width = SOCK_W, height = SOCK_H } = {}) {
  if (!Array.isArray(pets) || !pets.length) throw new Error('socks_pets_missing');
  const W = Math.round(width), H = Math.round(height);
  const plan = pattern.layout({ width: W, height: H, petCount: pets.length, side });
  const layers = [];
  for (const head of plan.heads) {
    const buf = await sprite(pets[head.pet], head.w, head.angle);
    const layer = await clipped(buf, head.cx, head.cy, W, H);
    if (layer) layers.push(layer);
  }
  for (const paw of plan.paws) {
    const buf = await sprite(decoSvg('paw', paw.size, paw.tint), paw.size, paw.angle);
    const layer = await clipped(buf, paw.cx, paw.cy, W, H);
    if (layer) layers.push(layer);
  }
  for (const heart of plan.hearts) {
    const buf = await sprite(decoSvg('heart', heart.size, heart.tint), heart.size, heart.angle);
    const layer = await clipped(buf, heart.cx, heart.cy, W, H);
    if (layer) layers.push(layer);
  }
  const base = hex(pattern.SOCK_BLUE);
  let img = sharp({ create: { width: W, height: H, channels: 4, background: base } });
  if (layers.length) img = img.composite(layers);
  const buffer = await img.withMetadata({ density: 300 }).png().toBuffer();
  const meta = await sharp(buffer).metadata();
  if (meta.width !== W || meta.height !== H) throw new Error(`render_size_mismatch:${meta.width}x${meta.height}`);
  const crypto = require('node:crypto');
  return {
    buffer, width: W, height: H, format: 'png',
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    stats: plan.stats, position: plan.position, side
  };
}

module.exports = { cropHead, stickerOutline, prepareHead, renderSock, decoSvg, SOCK_W, SOCK_H };
