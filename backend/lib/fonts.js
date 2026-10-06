'use strict';
// Fonts customers can pick for the pet name. The storefront loads the same families
// (same weights) from Google Fonts, so the preview and the print file use identical glyphs.
// Files are the Google Fonts builds published by Fontsource (SIL Open Font License).
const path = require('node:path');

const FONTS = {
  fredoka: { family: 'Fredoka', weight: 600, files: ['fredoka-latin-600-normal.woff', 'fredoka-latin-ext-600-normal.woff'] },
  pacifico: { family: 'Pacifico', weight: 400, files: ['pacifico-latin-400-normal.woff', 'pacifico-latin-ext-400-normal.woff'] },
  montserrat: { family: 'Montserrat', weight: 800, files: ['montserrat-latin-800-normal.woff', 'montserrat-latin-ext-800-normal.woff'] },
  playfair: { family: 'Playfair Display', weight: 700, files: ['playfair-display-latin-700-normal.woff', 'playfair-display-latin-ext-700-normal.woff'] }
};
const DEFAULT_FONT = 'fredoka';
const fontFile = name => path.join(__dirname, '..', 'fonts', name);

module.exports = { FONTS, DEFAULT_FONT, fontFile };
