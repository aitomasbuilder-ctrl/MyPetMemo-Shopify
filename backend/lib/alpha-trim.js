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

module.exports = { trimAlpha, OPAQUE };
