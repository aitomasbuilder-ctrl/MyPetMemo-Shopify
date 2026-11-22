'use strict';
// Neon Nights sometimes echoes the style-reference JPEG instead of drawing the
// customer's pet. Compare the portrait to a downscaled copy of that JPEG and
// refuse a near-copy before it can reach the shopper.
//
// The grid is built once from assets/style/neon-nights-ref.jpg (already shipped
// with the portrait function) and kept for the life of the process. Mean absolute
// channel difference is on a 0–255 scale. Downscaling makes the score stable
// under JPEG recompression and a shift of a few dozen pixels, which a full-size
// pixel diff is not.
//
// Production scores for this failure were 23 and 28 for copies and 44–59 for
// correct portraits. On this 96×128 grid the same pictures land in that gap:
// the attached copy failures score about 20–22 (a contact sheet is softer than
// the full file, so the live copies sit a little higher) and the correct
// portraits score about 42–50. COPY_MAX is 36, the middle of the empty range
// between 28 and 44. A portrait at or under 36 is treated as the reference.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const REFERENCE = path.join(__dirname, '..', 'assets', 'style', 'neon-nights-ref.jpg');
const GRID_W = 96;
const GRID_H = 128;
const COPY_MAX = 36;

let stored;

async function downscale(buf) {
  const { data, info } = await sharp(buf)
    .rotate()
    .resize(GRID_W, GRID_H, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== GRID_W || info.height !== GRID_H || info.channels !== 3) {
    throw new Error('reference grid');
  }
  return data;
}

/** RGB grid of the style reference, decoded and downscaled once. */
function referenceGrid() {
  if (!stored) stored = downscale(fs.readFileSync(REFERENCE)).catch(err => { stored = null; throw err; });
  return stored;
}

function meanAbsDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * Distance from the stored style reference.
 * `copy` is true when the portrait is close enough to be the reference image.
 * Null when `buf` is not a readable image. A failure to build the reference grid
 * is thrown: without that grid the guard cannot tell a copy from a portrait.
 * @returns {Promise<null | { score: number, copy: boolean }>}
 */
async function referenceDistance(buf) {
  const ref = await referenceGrid();
  try {
    const score = meanAbsDiff(ref, await downscale(buf));
    return { score, copy: score <= COPY_MAX };
  } catch {
    return null;
  }
}

module.exports = { referenceDistance, COPY_MAX, GRID_W, GRID_H };
