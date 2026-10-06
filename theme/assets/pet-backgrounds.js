/* MyPetMemo blanket backgrounds.
 * One source for the storefront preview (theme asset pet-backgrounds.js) and the
 * production renderer (backend). Every pattern is drawn in a coordinate system that is
 * 1000 units wide, so the preview and the print file look identical at any size.
 * Keep theme/assets/pet-backgrounds.js byte-identical to this file (a test checks it).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MyPetMemoBackgrounds = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HEART = 'M0 0.32C-0.18 0.18-0.52-0.04-0.52-0.3-0.52-0.5-0.36-0.62-0.2-0.62-0.1-0.62-0.03-0.57 0-0.5 0.03-0.57 0.1-0.62 0.2-0.62 0.36-0.62 0.52-0.5 0.52-0.3 0.52-0.04 0.18 0.18 0 0.32Z';
  var STAR = 'M0-1L0.235-0.324 0.951-0.309 0.38 0.124 0.588 0.809 0 0.4-0.588 0.809-0.38 0.124-0.951-0.309-0.235-0.324Z';
  var LEAF = 'M0-1C0.42-0.62 0.42 0.62 0 1-0.42 0.62-0.42-0.62 0-1Z';

  function f(n) { return Math.round(n * 100) / 100; }
  function at(x, y, s, r) { return 'translate(' + f(x) + ' ' + f(y) + ')' + (r ? ' rotate(' + f(r) + ')' : '') + ' scale(' + f(s) + ')'; }
  function shape(d, x, y, s, r, fill, extra) { return '<path d="' + d + '" transform="' + at(x, y, s, r) + '" fill="' + fill + '"' + (extra || '') + '/>'; }
  function pattern(id, w, h, body) {
    return '<defs><pattern id="' + id + '" patternUnits="userSpaceOnUse" width="' + w + '" height="' + h + '">' + body + '</pattern></defs>';
  }

  function hearts(colors, bg, tile) {
    return function () {
      var t = tile, body = '<rect width="' + t + '" height="' + t + '" fill="' + bg + '"/>';
      var spots = [[0.25, 0.25, 0.3, -12], [0.75, 0.75, 0.3, 14], [0.75, 0.22, 0.16, 8], [0.22, 0.76, 0.16, -6]];
      spots.forEach(function (p, i) { body += shape(HEART, p[0] * t, p[1] * t, p[2] * t, p[3], colors[i % colors.length]); });
      return pattern('p', t, t, body);
    };
  }

  function rainbowHearts() {
    var t = 180, colors = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#a855f7'];
    var body = '<rect width="' + t + '" height="' + t + '" fill="#fffaf3"/>';
    var spots = [[0.17, 0.17], [0.5, 0.17], [0.83, 0.17], [0.33, 0.67], [0.67, 0.67], [0, 0.67], [1, 0.67]];
    spots.forEach(function (p, i) { body += shape(HEART, p[0] * t, p[1] * t, 0.2 * t, (i % 2 ? 10 : -10), colors[i % 6]); });
    return pattern('p', t, t, body);
  }

  function florals() {
    var t = 220, body = '<rect width="' + t + '" height="' + t + '" fill="#fdf1e7"/>';
    var flowers = [[0.25, 0.27, 0.13, '#f4a6b8'], [0.75, 0.75, 0.13, '#c9b6e4'], [0.78, 0.2, 0.08, '#f8c79a'], [0.2, 0.8, 0.08, '#f8c79a']];
    flowers.forEach(function (fl) {
      var cx = fl[0] * t, cy = fl[1] * t, r = fl[2] * t;
      for (var k = 0; k < 5; k++) {
        var a = k * 72 * Math.PI / 180;
        body += '<circle cx="' + f(cx + Math.cos(a) * r * 0.62) + '" cy="' + f(cy + Math.sin(a) * r * 0.62) + '" r="' + f(r * 0.5) + '" fill="' + fl[3] + '"/>';
      }
      body += '<circle cx="' + f(cx) + '" cy="' + f(cy) + '" r="' + f(r * 0.32) + '" fill="#f6c84c"/>';
    });
    [[0.5, 0.5, 0.06, 40], [0.47, 0.07, 0.05, -30], [0.05, 0.47, 0.05, 70]].forEach(function (l) {
      body += shape(LEAF, l[0] * t, l[1] * t, l[2] * t, l[3], '#9cc29a');
    });
    return pattern('p', t, t, body);
  }

  function tropical() {
    var t = 260, body = '<rect width="' + t + '" height="' + t + '" fill="#f4efe1"/>';
    var leaves = [[0.25, 0.3, 0.26, -35, '#2f7d4f'], [0.72, 0.68, 0.28, 30, '#3f9a5f'], [0.78, 0.18, 0.16, 70, '#5bb37a'], [0.2, 0.82, 0.17, -70, '#1f6a43']];
    leaves.forEach(function (l) {
      var x = l[0] * t, y = l[1] * t, s = l[2] * t;
      body += shape(LEAF, x, y, s, l[3], l[4]);
      body += '<path d="M0-0.9L0 0.9" transform="' + at(x, y, s, l[3]) + '" stroke="#e8f3e6" stroke-width="0.04" fill="none"/>';
    });
    return pattern('p', t, t, body);
  }

  function clouds() {
    var t = 320, body = '<rect width="' + t + '" height="' + t + '" fill="#bfe2fb"/>';
    [[0.27, 0.28, 1], [0.76, 0.74, 1.15], [0.8, 0.16, 0.55]].forEach(function (c) {
      var x = c[0] * t, y = c[1] * t, s = c[2] * t * 0.1;
      [[-1.1, 0.25, 0.8], [0, 0, 1.15], [1.1, 0.25, 0.85], [0.5, 0.45, 0.75], [-0.5, 0.45, 0.75]].forEach(function (b) {
        body += '<circle cx="' + f(x + b[0] * s) + '" cy="' + f(y + b[1] * s) + '" r="' + f(b[2] * s) + '" fill="#ffffff"/>';
      });
    });
    return pattern('p', t, t, body);
  }

  function christmas() {
    var t = 240, body = '<rect width="' + t + '" height="' + t + '" fill="#b3202a"/>';
    [[0.25, 0.3], [0.75, 0.8]].forEach(function (p) {
      var x = p[0] * t, y = p[1] * t, s = t * 0.16;
      body += '<path d="M0-1.2L0.75 0.1H0.35L0.95 1H-0.95L-0.35 0.1H-0.75Z" transform="' + at(x, y, s) + '" fill="#1f6b3a"/>';
      body += '<rect x="' + f(x - s * 0.15) + '" y="' + f(y + s) + '" width="' + f(s * 0.3) + '" height="' + f(s * 0.3) + '" fill="#6b3f1d"/>';
      body += shape(STAR, x, y - s * 1.25, s * 0.28, 0, '#f6c84c');
    });
    [[0.72, 0.25], [0.28, 0.78], [0.5, 0.52], [0.05, 0.05], [0.95, 0.55]].forEach(function (p) {
      body += '<circle cx="' + f(p[0] * t) + '" cy="' + f(p[1] * t) + '" r="' + f(t * 0.018) + '" fill="#ffffff"/>';
    });
    return pattern('p', t, t, body);
  }

  function paws() {
    var t = 240, body = '<rect width="' + t + '" height="' + t + '" fill="#f7f1e6"/>';
    [[0.27, 0.3, -18], [0.75, 0.76, 16]].forEach(function (p) {
      var g = '<ellipse cx="0" cy="0.25" rx="0.42" ry="0.34"/><ellipse cx="-0.45" cy="-0.22" rx="0.15" ry="0.2"/><ellipse cx="-0.16" cy="-0.46" rx="0.15" ry="0.2"/><ellipse cx="0.16" cy="-0.46" rx="0.15" ry="0.2"/><ellipse cx="0.45" cy="-0.22" rx="0.15" ry="0.2"/>';
      body += '<g transform="' + at(p[0] * t, p[1] * t, t * 0.2, p[2]) + '" fill="#d9c3a5">' + g + '</g>';
    });
    return pattern('p', t, t, body);
  }

  function stars() {
    var t = 200, body = '<rect width="' + t + '" height="' + t + '" fill="#14234d"/>';
    [[0.25, 0.25, 0.07], [0.75, 0.7, 0.07], [0.78, 0.18, 0.035], [0.2, 0.78, 0.035], [0.5, 0.5, 0.025]].forEach(function (s, i) {
      body += shape(STAR, s[0] * t, s[1] * t, s[2] * t, i * 11, '#f3c969');
    });
    return pattern('p', t, t, body);
  }

  function gradient(a, b, angle) {
    return function () {
      return '<defs><linearGradient id="p" gradientTransform="rotate(' + (angle || 90) + ' .5 .5)"><stop offset="0" stop-color="' + a + '"/><stop offset="1" stop-color="' + b + '"/></linearGradient></defs>';
    };
  }

  // Order is the order shown to customers. `swatch` is the CSS used for the round button.
  var LIST = [
    { id: 'pink-hearts', name: 'Pink Hearts', kind: 'pattern', color: '#f9c9d8', draw: hearts(['#f06292', '#f06292', '#ffffff', '#ffffff'], '#f9c9d8', 190) },
    { id: 'rainbow-hearts', name: 'Rainbow Hearts', kind: 'pattern', color: '#fffaf3', draw: rainbowHearts },
    { id: 'red-hearts', name: 'Red Hearts', kind: 'pattern', color: '#fff4f2', draw: hearts(['#e11d48', '#e11d48', '#fb7185', '#fb7185'], '#fff4f2', 190) },
    { id: 'florals', name: 'Florals', kind: 'pattern', color: '#fdf1e7', draw: florals },
    { id: 'tropical-leaves', name: 'Tropical Leaves', kind: 'pattern', color: '#f4efe1', draw: tropical },
    { id: 'clouds', name: 'Clouds', kind: 'pattern', color: '#bfe2fb', draw: clouds },
    { id: 'christmas-trees', name: 'Christmas Trees', kind: 'pattern', color: '#b3202a', draw: christmas },
    { id: 'paw-prints', name: 'Paw Prints', kind: 'pattern', color: '#f7f1e6', draw: paws },
    { id: 'starry-night', name: 'Starry Night', kind: 'pattern', color: '#14234d', draw: stars },
    { id: 'sunset', name: 'Sunset', kind: 'gradient', color: '#fda085', draw: gradient('#ffd3a5', '#fd6585') },
    { id: 'ocean', name: 'Ocean', kind: 'gradient', color: '#a1c4fd', draw: gradient('#c2e9fb', '#6f9ce8') },
    { id: 'lavender', name: 'Lavender', kind: 'gradient', color: '#cdb8f5', draw: gradient('#f1e4ff', '#a98ee6') },
    { id: 'mint', name: 'Mint', kind: 'gradient', color: '#bfe8d6', draw: gradient('#e9fbf2', '#8fd3b6') },
    { id: 'cream', name: 'Cream', kind: 'solid', color: '#f7f1e6' },
    { id: 'blush', name: 'Blush', kind: 'solid', color: '#f8d7da' },
    { id: 'sky', name: 'Sky Blue', kind: 'solid', color: '#cfe8f7' },
    { id: 'sage', name: 'Sage', kind: 'solid', color: '#c9d8c5' },
    { id: 'lilac', name: 'Lilac', kind: 'solid', color: '#ddd0ef' },
    { id: 'sunshine', name: 'Sunshine', kind: 'solid', color: '#ffe08a' },
    { id: 'navy', name: 'Navy', kind: 'solid', color: '#1b2a4e' },
    { id: 'charcoal', name: 'Charcoal', kind: 'solid', color: '#2f3640' },
    { id: 'white', name: 'White', kind: 'solid', color: '#ffffff' }
  ];
  var BY_ID = {};
  LIST.forEach(function (b) { BY_ID[b.id] = b; });

  var HEX = /^#[0-9a-f]{6}$/i;

  /** Full SVG document for a pattern, gradient or solid background, `w` x `h` pixels. */
  function svg(bg, w, h, viewWidth) {
    var vw = viewWidth || 1000, vh = f(vw * h / w);
    var def = bg && BY_ID[bg.id];
    var fill, defs = '';
    if (def && def.draw) { defs = def.draw(); fill = 'url(#p)'; }
    else if (def) fill = def.color;
    else if (bg && HEX.test(bg.color || '')) fill = bg.color;
    else fill = '#ffffff';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + Math.round(w) + '" height="' + Math.round(h) + '" viewBox="0 0 ' + vw + ' ' + vh + '" preserveAspectRatio="none">' +
      defs + '<rect width="' + vw + '" height="' + vh + '" fill="' + fill + '"/></svg>';
  }

  /** Small square SVG used as the swatch image. */
  function swatchSvg(id) {
    var def = BY_ID[id];
    if (!def) return '';
    return svg(def, 96, 96, def.kind === 'pattern' ? 340 : 1000);
  }

  return { list: LIST, byId: BY_ID, svg: svg, swatchSvg: swatchSvg, isHex: function (c) { return HEX.test(c || ''); } };
});
