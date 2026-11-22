'use strict';
// Crops a cut-out to the bounding box of its alpha, plus a small margin, so a
// pet photo is not a tiny subject in a large transparent canvas.
const sharp = require('sharp');

const OPAQUE = 12;

async function trimAlpha(png, { marginRatio = 0.015 } = {}) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, c = info.channels;
  let minx = w, miny = h, maxx = -1, maxy = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * c;
    for (let x = 0; x < w; x++) {
      if (data[row + x * c + 3] > OPAQUE) {
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
      }
    }
  }
  if (maxx < 0) return png;
  const margin = Math.max(2, Math.round(marginRatio * Math.max(maxx - minx + 1, maxy - miny + 1)));
  const left = Math.max(0, minx - margin);
  const top = Math.max(0, miny - margin);
  const right = Math.min(w - 1, maxx + margin);
  const bottom = Math.min(h - 1, maxy + margin);
  const width = right - left + 1, height = bottom - top + 1;
  if (left === 0 && top === 0 && width === w && height === h) return png;
  return sharp(png).extract({ left, top, width, height }).png().toBuffer();
}

/**
 * Drops disconnected scraps (a leaf, a patch of floor) while keeping every
 * large subject, so a photo of two pets does not lose one of them.
 */
async function dropSpecks(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, c = info.channels;
  const n = w * h;
  const seen = new Uint8Array(n);
  const labels = [];
  const qx = new Int32Array(n), qy = new Int32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const start = y * w + x;
    if (seen[start] || data[start * c + 3] <= OPAQUE) continue;
    let qs = 0, qe = 0;
    qx[qe] = x; qy[qe] = y; qe++;
    seen[start] = 1;
    const pixels = [];
    while (qs < qe) {
      const cx = qx[qs], cy = qy[qs]; qs++;
      pixels.push(cy * w + cx);
      const neigh = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
      for (const [nx, ny] of neigh) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (seen[ni] || data[ni * c + 3] <= OPAQUE) continue;
        seen[ni] = 1;
        qx[qe] = nx; qy[qe] = ny; qe++;
      }
    }
    labels.push(pixels);
  }
  if (labels.length < 2) return png;
  let largest = 0;
  for (const pixels of labels) if (pixels.length > largest) largest = pixels.length;
  const keep = Math.max(64, Math.round(largest * 0.02));
  let removed = 0;
  for (const pixels of labels) {
    if (pixels.length >= keep) continue;
    removed += pixels.length;
    for (const i of pixels) {
      data[i * c] = 0; data[i * c + 1] = 0; data[i * c + 2] = 0; data[i * c + 3] = 0;
    }
  }
  if (!removed) return png;
  return sharp(data, { raw: { width: w, height: h, channels: c } }).png().toBuffer();
}

module.exports = { trimAlpha, dropSpecks, OPAQUE };
