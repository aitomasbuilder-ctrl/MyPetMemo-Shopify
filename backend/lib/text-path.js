'use strict';
// Turns the pet name into SVG path data with the same font files the storefront uses,
// so the production renderer never depends on fonts installed on the server.
const opentype = require('opentype.js');
const { FONTS, fontFile } = require('./fonts');

const cache = new Map();
function faces(key) {
  if (!FONTS[key]) throw new Error(`unknown_font:${key}`);
  if (!cache.has(key)) cache.set(key, FONTS[key].files.map(f => opentype.loadSync(fontFile(f))));
  return cache.get(key);
}

// Each character is drawn with the first subset (latin, then latin-ext) that contains it.
function faceFor(list, ch) {
  if (ch === ' ') return list[0];
  return list.find(f => f.charToGlyphIndex(ch) > 0) || null;
}

function missingCharacters(text, key) {
  const list = faces(key);
  return Array.from(new Set(Array.from(String(text)).filter(ch => !faceFor(list, ch))));
}

// Splits text into runs that share a font subset; kerning applies inside a run.
function runs(text, list) {
  const out = [];
  for (const ch of Array.from(text)) {
    const face = faceFor(list, ch);
    if (!face) throw new Error(`unsupported_character:${ch}`);
    const last = out[out.length - 1];
    if (last && last.face === face) last.text += ch; else out.push({ face, text: ch });
  }
  return out;
}

function measure(text, key, size) {
  return runs(text, faces(key)).reduce((w, r) => w + r.face.getAdvanceWidth(r.text, size, { kerning: true }), 0);
}

/** Path data for `text` centred on x = cx with its alphabetic baseline at y = baseline. */
function textPath(text, key, size, cx, baseline) {
  const list = runs(text, faces(key));
  const width = list.reduce((w, r) => w + r.face.getAdvanceWidth(r.text, size, { kerning: true }), 0);
  let x = cx - width / 2;
  let d = '';
  for (const r of list) {
    d += r.face.getPath(r.text, x, baseline, size, { kerning: true }).toPathData(2);
    x += r.face.getAdvanceWidth(r.text, size, { kerning: true });
  }
  return { d, width };
}

module.exports = { textPath, measure, missingCharacters };
