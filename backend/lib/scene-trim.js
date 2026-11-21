'use strict';
// Scene portraits sometimes come back letterboxed: near-white (or flat) bars on the
// edges of the 3:4 frame. Crop those bars and cover-fill back to the same frame so
// the print is full-bleed. A picture with no bar is returned unchanged.
const sharp = require('sharp');

const MAX_FRACTION = 0.18;
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

/** How far a padding bar runs in from one edge. 0 when the edge is the picture. */
function inset(data, w, h, ch, vertical, fromStart) {
  const len = vertical ? w : h;
  const limit = Math.min(Math.floor(len * MAX_FRACTION), len - MIN_RUN - 1);
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
  const content = lineStats(data, w, h, ch, vertical, next);
  if (dist(content.mean, edge.mean) < CONTENT_GAP) return 0;
  return run;
}

/**
 * Crops near-white or flat edge bars and cover-fills back to the source frame
 * (the 3:4 canvas the scene was requested in). No bar: the same buffer.
 * @returns {Promise<{ buffer: Buffer, trimmed: boolean }>}
 */
async function trimSceneBorder(buf) {
  let data, info;
  try {
    ({ data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true }));
  } catch {
    return { buffer: buf, trimmed: false };
  }
  const { width: w, height: h, channels: ch } = info;
  if (!(w > 16 && h > 16) || ch < 3) return { buffer: buf, trimmed: false };
  const left = inset(data, w, h, ch, true, true);
  const right = inset(data, w, h, ch, true, false);
  const top = inset(data, w, h, ch, false, true);
  const bottom = inset(data, w, h, ch, false, false);
  if (!(left || right || top || bottom)) return { buffer: buf, trimmed: false };
  const cw = w - left - right, chh = h - top - bottom;
  if (cw < 8 || chh < 8 || left + right >= w || top + bottom >= h) return { buffer: buf, trimmed: false };
  const buffer = await sharp(buf)
    .extract({ left, top, width: cw, height: chh })
    .resize(w, h, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
  return { buffer, trimmed: true };
}

module.exports = { trimSceneBorder };
