'use strict';
// Approved v3 sock layout (make_v3_pattern): large faces, mixed tilts, sparse white
// paws and hearts on light blue. Positions are fractions of the 1417×4252 print,
// so a small preview and the paid print file use the same placement.
// This file is copied to the storefront bundle. Keep them identical.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MpmSockPattern = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SOCK_W = 1417;
  const SOCK_H = 4252;
  // Average of the approved light-blue ground.
  const SOCK_BLUE = '#a0cedd';
  const SEEDS = { left: 42, right: 48 };
  const V3 = {
    spacingMul: 1.49,
    headFrac: 0.27,
    pawPerHead: 0.70,
    heartPerHead: 0.65,
    decoSizeMul: 1.12,
    angleSpan: 24,
    extraPerHead: 0.22
  };
  const TINTS = ['#ffffff', '#f7fcfe', '#e8f4f8'];
  const PAW = {
    pad: [0.50, 0.68, 0.28, 0.24],
    toes: [[0.22, 0.32, 0.13, 0.16], [0.40, 0.20, 0.12, 0.15], [0.60, 0.20, 0.12, 0.15], [0.78, 0.32, 0.13, 0.16]]
  };
  const POSITIONS = { left: 'left_leg', right: 'right_leg' };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rngApi(seed) {
    const next = mulberry32(seed);
    return {
      random: next,
      uniform(a, b) { return a + next() * (b - a); },
      choice(arr) { return arr[Math.floor(next() * arr.length)]; },
      shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
        return arr;
      }
    };
  }

  function overlaps(cx, cy, rw, rh, width, height) {
    return (cx + rw / 2) > 0 && (cx - rw / 2) < width && (cy + rh / 2) > 0 && (cy - rh / 2) < height;
  }

  function tooClose(list, cx, cy, r, pad) {
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const dx = cx - o.cx, dy = cy - o.cy;
      const min = (r + o.r) * pad;
      if (dx * dx + dy * dy < min * min) return true;
    }
    return false;
  }

  /**
   * One sock. `side` is "left" or "right" (different seeds, so the tilts differ).
   * With more than one pet, faces alternate. The right sock starts on the other pet.
   */
  function layout(opts) {
    const o = opts || {};
    const width = o.width > 0 ? o.width : SOCK_W;
    const height = o.height > 0 ? o.height : SOCK_H;
    const n = Math.max(1, Math.min(4, o.petCount | 0 || 1));
    const side = o.side === 'right' ? 'right' : 'left';
    const seed = o.seed == null ? SEEDS[side] : (o.seed | 0);
    const rng = rngApi(seed);
    const headTarget = width * V3.headFrac;
    const scales = [0.92, 0.96, 1, 1, 1.04, 1.08];
    const spacingX = headTarget * 1.30 * V3.spacingMul;
    const spacingY = headTarget * 1.24 * V3.spacingMul;
    const cols = Math.ceil(width / spacingX) + 3;
    const rows = Math.ceil(height / spacingY) + 3;
    const occupied = [];
    const heads = [];
    const phase = side === 'right' && n > 1 ? 1 : 0;

    for (let row = -1; row < rows; row++) {
      const y = row * spacingY + spacingY * 0.15;
      const xoff = (((row % 2) + 2) % 2) ? spacingX * 0.5 : 0;
      for (let col = -1; col < cols; col++) {
        const cx = col * spacingX + xoff + spacingX * 0.2 + rng.uniform(-0.09, 0.09) * spacingX;
        const cy = y + rng.uniform(-0.08, 0.08) * spacingY;
        const scale = rng.choice(scales);
        let angle = rng.uniform(-V3.angleSpan, V3.angleSpan);
        if (Math.abs(angle) < 4) angle = rng.random() < 0.5 ? 9 : -10;
        const box = headTarget * scale;
        const r = box * 0.48;
        if (tooClose(occupied, cx, cy, r, 0.90)) continue;
        occupied.push({ cx, cy, r });
        heads.push({
          cx, cy, w: box, angle, scale,
          pet: (heads.length + phase) % n,
          visible: overlaps(cx, cy, box, box, width, height)
        });
      }
    }

    const pawSizes = [0.28, 0.32, 0.36, 0.24].map(s => headTarget * s * V3.decoSizeMul);
    const heartSizes = [0.20, 0.24, 0.18, 0.26].map(s => headTarget * s * V3.decoSizeMul);
    const gaps = [];
    for (let row = -1; row < rows + 1; row++) {
      const y = row * spacingY + spacingY * 0.65;
      const xoff = (((row % 2) + 2) % 2) === 0 ? spacingX * 0.5 : 0;
      for (let col = -1; col < cols + 1; col++) {
        gaps.push([
          col * spacingX + xoff + spacingX * 0.2 + rng.uniform(-0.18, 0.18) * spacingX,
          y + rng.uniform(-0.18, 0.18) * spacingY
        ]);
      }
    }
    const deco = [];
    const far = (cx, cy, r) => !tooClose(occupied, cx, cy, r, 0.92) && !tooClose(deco, cx, cy, r, 1.45);
    rng.shuffle(gaps);
    const paws = [];
    const hearts = [];
    const pushDeco = (list, cx, cy, size, angle) => {
      deco.push({ cx, cy, r: size * 0.45 });
      list.push({ cx, cy, size, angle, tint: rng.choice([0, 1, 2]), visible: overlaps(cx, cy, size, size, width, height) });
    };
    let pi = 0;
    const nPaws = Math.floor(occupied.length * V3.pawPerHead);
    for (let i = 0; i < gaps.length && pi < nPaws; i++) {
      const size = rng.choice(pawSizes);
      const r = size * 0.45;
      const cx = gaps[i][0], cy = gaps[i][1];
      if (!far(cx, cy, r)) continue;
      pushDeco(paws, cx, cy, size, rng.uniform(-40, 40));
      pi++;
    }
    let hi = 0;
    const nHearts = Math.floor(occupied.length * V3.heartPerHead);
    for (let i = 0; i < gaps.length && hi < nHearts; i++) {
      const cx = gaps[i][0] + rng.uniform(-0.25, 0.25) * spacingX;
      const cy = gaps[i][1] + rng.uniform(-0.25, 0.25) * spacingY;
      const size = rng.choice(heartSizes);
      if (!far(cx, cy, size * 0.42)) continue;
      pushDeco(hearts, cx, cy, size, rng.uniform(-28, 28));
      hi++;
    }
    const extra = [];
    const step = Math.min(spacingX, spacingY) * 0.38;
    for (let y = -spacingY; y < height + spacingY; y += step) {
      const shift = (Math.floor(y / step) % 2 === 0) ? 0 : step * 0.5;
      for (let x = -spacingX + shift; x < width + spacingX; x += step) {
        extra.push([x + rng.uniform(-0.2, 0.2) * step, y + rng.uniform(-0.2, 0.2) * step]);
      }
    }
    rng.shuffle(extra);
    const extrasTarget = Math.floor(occupied.length * V3.extraPerHead);
    let extras = 0;
    for (let i = 0; i < extra.length && extras < extrasTarget; i++) {
      const cx = extra[i][0], cy = extra[i][1];
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
      const usePaw = rng.random() < 0.55;
      const size = rng.choice(usePaw ? pawSizes : heartSizes);
      if (!far(cx, cy, size * (usePaw ? 0.45 : 0.42))) continue;
      pushDeco(usePaw ? paws : hearts, cx, cy, size, rng.uniform(-36, 36));
      extras++;
    }

    return {
      width, height, side, seed, petCount: n, position: POSITIONS[side],
      headTarget, spacingX, spacingY, heads, paws, hearts,
      stats: {
        headsPlaced: heads.length,
        headsVisible: heads.filter(h => h.visible).length,
        pawsVisible: paws.filter(p => p.visible).length,
        heartsVisible: hearts.filter(h => h.visible).length
      }
    };
  }

  return { layout, SOCK_W, SOCK_H, SOCK_BLUE, SEEDS, V3, TINTS, PAW, POSITIONS };
});
