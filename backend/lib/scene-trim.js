'use strict';
// Scene portraits sometimes come back letterboxed: near-white (or flat) bars on the
// edges of the 3:4 frame. Crop those bars and cover-fill back to the same frame so
// the print is full-bleed. A picture with no bar is returned unchanged.
// A bar thicker than MAX_FRACTION used to be treated as a solid field and left on
// the print. The portrait handler detects those, regenerates once, then crops one
// when at least MIN_REMAINING of the height or width is still the picture.
const sharp = require('sharp');

const MAX_FRACTION = 0.18;
const MIN_REMAINING = 0.6;
const MIN_RUN = 4;
const WHITE = 232;
const WHITE_STD = 28;
const PAD_STD = 12;
const EDGE_MATCH = 18;
const CONTENT_GAP = 36;

const dist = (a, b) => {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
};

/** Mean colour and spread of one column (vertical) or row. */
function lineStats(data, w, h, ch, vertical, index) {
  const n = vertical ? h : w;
  let sr = 0, sg = 0, sb = 0, sr2 = 0, sg2 = 0, sb2 = 0, white = 0;
  for (let i = 0; i < n; i++) {
    const x = vertical ? index : i;
    const y = vertical ? i : index;
    const o = (y * w + x) * ch;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    sr += r; sg += g; sb += b;
    sr2 += r * r; sg2 += g * g; sb2 += b * b;
    if (r >= WHITE && g >= WHITE && b >= WHITE) white++;
  }
  const mean = [sr / n, sg / n, sb / n];
  const std = [sr2, sg2, sb2].map((s, i) => Math.sqrt(Math.max(0, s / n - mean[i] * mean[i])));
  return { mean, std, whiteRatio: white / n };
}

/** A padding line: near-white, or the same flat colour as the outer edge. */
function isPad(st, edgeMean) {
  const close = dist(st.mean, edgeMean) <= (st.whiteRatio >= 0.8 ? 30 : EDGE_MATCH);
  if (!close) return false;
  if (st.whiteRatio >= 0.8 && st.std[0] <= WHITE_STD && st.std[1] <= WHITE_STD && st.std[2] <= WHITE_STD) return true;
  return st.std[0] <= PAD_STD && st.std[1] <= PAD_STD && st.std[2] <= PAD_STD;
}

/**
 * How far a padding bar runs in from one edge.
 * 0 when the edge is the picture, or when the same flat field continues (a night sky).
 * maxFraction stops the search; 1 walks the whole edge.
 */
function barRun(data, w, h, ch, vertical, fromStart, maxFraction) {
  const len = vertical ? w : h;
  const limit = Math.min(Math.floor(len * maxFraction), len - MIN_RUN - 1);
  if (limit < MIN_RUN) return 0;
  const edge = lineStats(data, w, h, ch, vertical, fromStart ? 0 : len - 1);
  if (!isPad(edge, edge.mean)) return 0;
  let run = 0;
  while (run < limit) {
    const index = fromStart ? run : len - 1 - run;
    if (!isPad(lineStats(data, w, h, ch, vertical, index), edge.mean)) break;
    run++;
  }
  if (run < MIN_RUN) return 0;
  // A flat sky or a solid field continues; a bar stops where the picture changes.
  const next = fromStart ? run : len - 1 - run;
  if (next < 0 || next >= len) return 0;
  const content = lineStats(data, w, h, ch, vertical, next);
  if (dist(content.mean, edge.mean) < CONTENT_GAP) return 0;
  return run;
}

/** The trim cap. Bars thicker than this are left for a retry, then a forced crop. */
function inset(data, w, h, ch, vertical, fromStart) {
  return barRun(data, w, h, ch, vertical, fromStart, MAX_FRACTION);
}

async function raw(buf) {
  try {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h, channels: ch } = info;
    if (!(w > 16 && h > 16) || ch < 3) return null;
    return { data, w, h, ch };
  } catch {
    return null;
  }
}

function edges(data, w, h, ch, maxFraction) {
  return {
    left: barRun(data, w, h, ch, true, true, maxFraction),
    right: barRun(data, w, h, ch, true, false, maxFraction),
    top: barRun(data, w, h, ch, false, true, maxFraction),
    bottom: barRun(data, w, h, ch, false, false, maxFraction),
    width: w,
    height: h
  };
}

function overCap(px, len) {
  return px > Math.floor(len * MAX_FRACTION);
}

function edgeSummary(e) {
  const sides = [];
  if (overCap(e.left, e.width)) sides.push('left');
  if (overCap(e.right, e.width)) sides.push('right');
  if (overCap(e.top, e.height)) sides.push('top');
  if (overCap(e.bottom, e.height)) sides.push('bottom');
  return sides.length ? { ...e, sides } : null;
}

async function cover(buf, left, top, cw, chh, w, h) {
  return sharp(buf)
    .extract({ left, top, width: cw, height: chh })
    .resize(w, h, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
}

/**
 * A near-white or flat edge bar thicker than the trim cap, on any side.
 * A full-bleed picture and a flat field (a dark night sky) return null.
 * @returns {Promise<null | { left: number, right: number, top: number, bottom: number, width: number, height: number, sides: string[] }>}
 */
async function thickSceneBar(buf) {
  const img = await raw(buf);
  if (!img) return null;
  return edgeSummary(edges(img.data, img.w, img.h, img.ch, 1));
}

/**
 * Crops near-white or flat edge bars and cover-fills back to the source frame
 * (the 3:4 canvas the scene was requested in). No bar: the same buffer.
 * Bars thicker than the trim cap are not cropped here.
 * @returns {Promise<{ buffer: Buffer, trimmed: boolean }>}
 */
async function trimSceneBorder(buf) {
  const img = await raw(buf);
  if (!img) return { buffer: buf, trimmed: false };
  const { data, w, h, ch } = img;
  const left = inset(data, w, h, ch, true, true);
  const right = inset(data, w, h, ch, true, false);
  const top = inset(data, w, h, ch, false, true);
  const bottom = inset(data, w, h, ch, false, false);
  if (!(left || right || top || bottom)) return { buffer: buf, trimmed: false };
  const cw = w - left - right, chh = h - top - bottom;
  if (cw < 8 || chh < 8 || left + right >= w || top + bottom >= h) return { buffer: buf, trimmed: false };
  const buffer = await cover(buf, left, top, cw, chh, w, h);
  return { buffer, trimmed: true };
}

/**
 * Crop a thick edge bar and cover-fill back onto the source frame (scene styles
 * are requested at 3:4). Null when less than 60% of the height or width would remain.
 * @returns {Promise<null | { buffer: Buffer, trimmed: true }>}
 */
async function cropThickSceneBorder(buf) {
  const img = await raw(buf);
  if (!img) return null;
  const e = edges(img.data, img.w, img.h, img.ch, 1);
  const cw = e.width - e.left - e.right;
  const chh = e.height - e.top - e.bottom;
  if (!(e.left || e.right || e.top || e.bottom)) return null;
  if (cw / e.width < MIN_REMAINING || chh / e.height < MIN_REMAINING) return null;
  if (cw < 8 || chh < 8) return null;
  const buffer = await cover(buf, e.left, e.top, cw, chh, e.width, e.height);
  return { buffer, trimmed: true };
}

module.exports = { trimSceneBorder, thickSceneBar, cropThickSceneBorder };
