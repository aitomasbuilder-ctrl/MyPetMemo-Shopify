'use strict';
// Scene-blanket names: a script name stored at size 0.13 (northern-night, neon-nights) is drawn a little
// smaller, and no scene name is wider than 70% of the print. The storefront uses the same numbers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const design = require('../lib/design');
const { measure } = require('../lib/text-path');
const { renderDesign, fittedNameSize, SCENE_NAME_MAX_WIDTH, SCENE_SCRIPT_SIZE } = require('../lib/render');

const hosts = ['cdn.shopify.com'];
const NIGHT = '#0b1030';
const NEON = '#1b0b33';
const CHRISTMAS = '#5b1a1c';
const MOON = '#141a2b';

test('fitted name size: 0.13 script on a scene tightens to 0.11, then caps at 70% of the print', () => {
  const luna = { text: 'Luna', font: 'msmadi', size: 0.13 };
  assert.strictEqual(fittedNameSize(luna, 1000, true), SCENE_SCRIPT_SIZE);
  assert.strictEqual(fittedNameSize(luna, 7875, true), fittedNameSize(luna, 1000, true), 'same fraction at any print width');
  const wide = measure('Luna', 'msmadi', SCENE_SCRIPT_SIZE * 1000) / 1000;
  const was = measure('Luna', 'msmadi', 0.13 * 1000) / 1000;
  assert.ok(wide < was, `Luna got narrower (${wide} vs ${was})`);
  assert.ok(wide < SCENE_NAME_MAX_WIDTH);

  const long = { text: 'M'.repeat(24), font: 'msmadi', size: 0.13 };
  const fitted = fittedNameSize(long, 2000, true);
  const frac = measure(long.text, long.font, fitted * 2000) / 2000;
  assert.ok(Math.abs(frac - SCENE_NAME_MAX_WIDTH) < 1e-9, `long name fills the cap, got ${frac}`);
  assert.strictEqual(fittedNameSize(long, 2000, true), fitted);

  assert.strictEqual(fittedNameSize({ text: 'Luna', font: 'msmadi', size: 0.11 }, 1000, true), 0.11, 'already 0.11 is not shrunk again');
  assert.strictEqual(fittedNameSize({ text: 'Luna', font: 'msmadi', size: 0.15 }, 1000, true), 0.15, 'christmas size stays');
  assert.strictEqual(fittedNameSize({ text: 'Luna', font: 'fredoka', size: 0.13 }, 1000, true), 0.13, 'only the script face at 0.13 is reduced');
  assert.strictEqual(fittedNameSize(luna, 1000, false), 0.13, 'watercolor and other blankets are left alone');
});

test('render: a scene script name at 0.13 is narrower than the same name off a scene, and a long name stays within 70%', async () => {
  const art = await sharp({ create: { width: 80, height: 80, channels: 4, background: { r: 220, g: 20, b: 20, alpha: 1 } } }).png().toBuffer();
  const sha = require('../lib/render').sha256(art);
  async function paint(over) {
    const d = design.normalise({
      product_id: '1', variant_id: '2', sku: 'S', print: { w: 600, h: 720 },
      background: { id: 'custom', kind: 'solid', color: over.color, name: 'Scene' },
      pet: { cx: 0.5, cy: 0.3, w: 0.2, rot: 0 },
      name: { text: over.text, cx: 0.5, cy: 0.8, size: over.size, rot: 0, font: over.font, fill: '#f6dc8f', stroke: '#f6dc8f' },
      artwork: { sha256: sha, w: 80, h: 80 }
    }, { hosts });
    const r = await renderDesign({ design: d, artwork: art, width: 600, height: 720, format: 'png' });
    const { data, info } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
    let min = info.width, max = -1;
    for (let y = 400; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * info.channels;
        if (data[i] > 180 && data[i + 1] > 150 && data[i + 2] < 180) { if (x < min) min = x; if (x > max) max = x; }
      }
    }
    return { span: max - min + 1, width: info.width };
  }
  const scene = await paint({ text: 'Luna', size: 0.13, font: 'msmadi', color: NIGHT });
  const plain = await paint({ text: 'Luna', size: 0.13, font: 'msmadi', color: '#ffffff' });
  assert.ok(scene.span < plain.span, `scene Luna ${scene.span}px should be narrower than ${plain.span}px`);
  assert.ok(scene.span / scene.width < 0.30, `tightened Luna is well under the cap (${scene.span})`);
  const ratio = scene.span / plain.span;
  assert.ok(ratio > 0.80 && ratio < 0.90, `about 0.11/0.13, got ${ratio}`);

  const neon = await paint({ text: 'Luna', size: 0.13, font: 'msmadi', color: NEON });
  assert.strictEqual(neon.span, scene.span, 'neon-nights uses the same fit as northern-night');
  const tree = await paint({ text: 'Luna', size: 0.15, font: 'msmadi', color: CHRISTMAS });
  assert.ok(tree.span > scene.span, 'the larger christmas name is not pulled down to 0.11');
  const moon = await paint({ text: 'Luna', size: 0.11, font: 'msmadi', color: MOON });
  assert.strictEqual(moon.span, scene.span, 'moonlight at 0.11 matches the tightened script size');

  const long = await paint({ text: 'M'.repeat(24), size: 0.13, font: 'msmadi', color: NIGHT });
  assert.ok(long.span / long.width <= 0.75, `long name stays near 70% of the print (${long.span / long.width})`);
  assert.ok(long.span / long.width > 0.60, `long name still uses the width it is allowed (${long.span / long.width})`);
});

test('storefront scene layouts use the tighter script size and the same 70% cap', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'theme', 'assets', 'pet-studio.js'), 'utf8');
  assert.match(src, /'northern-night': \{ label: 'Northern Night', color: '#0b1030', ink: '#f6dc8f', name: \{ cx: 0\.7, cy: 0\.84, size: 0\.11, rot: -6 \} \}/);
  assert.match(src, /'neon-nights': \{ label: 'Neon Nights', color: '#1b0b33', ink: '#ff5fd2', name: \{ cx: 0\.5, cy: 0\.9, size: 0\.11, rot: -4 \} \}/);
  assert.match(src, /moonlight: \{ label: 'Moonlight night', color: '#141a2b', ink: '#ffffff', name: \{ cx: 0\.7, cy: 0\.87, size: 0\.11, rot: -8 \} \}/);
  assert.match(src, /christmas: \{ label: 'Cozy Christmas', color: '#5b1a1c', ink: '#fff6e6', name: \{ cx: 0\.5, cy: 0\.89, size: 0\.15, rot: -4 \} \}/);
  assert.match(src, /Math\.abs\(size - 0\.13\) < 0\.0005\) size = 0\.11/);
  assert.match(src, /scene \? 0\.70 \/ Math\.max\(w, 0\.01\)/);
});
