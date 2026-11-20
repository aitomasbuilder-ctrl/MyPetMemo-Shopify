'use strict';
const { describe, test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { upscaleArtwork } = require('../lib/upscale');
const { prepareDesignItems } = require('../lib/design-fulfillment');

const art = (alpha) => sharp({ create: { width: 40, height: 30, channels: alpha ? 4 : 3, background: alpha ? { r: 200, g: 120, b: 40, alpha: 0.5 } : '#0b1030' } }).png().toBuffer();

describe('upscale', { concurrency: false }, () => {
  test('small artwork printed large is enlarged x4 by the model', async () => {
    const r = await upscaleArtwork(await art(false), { printedWidth: 400, enabled: true });
    assert.strictEqual(r.upscaled, true);
    const m = await sharp(r.buffer).metadata();
    assert.deepStrictEqual([m.width, m.height], [160, 120]);
  });

  test('keeps transparency of cut-out pets', async () => {
    const r = await upscaleArtwork(await art(true), { printedWidth: 400, enabled: true });
    const m = await sharp(r.buffer).metadata();
    assert.strictEqual(r.upscaled, true); assert.strictEqual(m.hasAlpha, true);
    const { data } = await sharp(r.buffer).raw().toBuffer({ resolveWithObject: true });
    assert.ok(Math.abs(data[3] - 128) <= 2);
  });

  test('skipped when not needed, too large, unreadable, or out of time (fail-open)', async () => {
    const b = await art(false);
    assert.strictEqual((await upscaleArtwork(b, { printedWidth: 50, enabled: true })).info, 'not_needed');
    assert.strictEqual((await upscaleArtwork(b, { printedWidth: 400, enabled: true, maxPixels: 10 })).info, 'too_large');
    const bad = Buffer.from('not an image');
    const unreadable = await upscaleArtwork(bad, { printedWidth: 400, enabled: true });
    assert.strictEqual(unreadable.buffer, bad);
    assert.strictEqual(unreadable.info, 'unreadable');
    const budget = await upscaleArtwork(b, { printedWidth: 400, enabled: true, deadline: Date.now() - 5 });
    assert.strictEqual(budget.info, 'budget');
    assert.strictEqual(budget.buffer, b);
    const tooSlow = await upscaleArtwork(b, { printedWidth: 400, enabled: true, deadline: Date.now() + 1 });
    assert.strictEqual(tooSlow.info, 'budget');
  });

  test('off unless UPSCALE_ARTWORK=on; the off switch still disables it', async () => {
    const b = await art(false);
    const prev = process.env.UPSCALE_ARTWORK;
    try {
      delete process.env.UPSCALE_ARTWORK;
      assert.strictEqual((await upscaleArtwork(b, { printedWidth: 400 })).info, 'disabled');
      process.env.UPSCALE_ARTWORK = 'off';
      assert.strictEqual((await upscaleArtwork(b, { printedWidth: 400 })).info, 'disabled');
      process.env.UPSCALE_ARTWORK = 'on';
      const on = await upscaleArtwork(b, { printedWidth: 400 });
      assert.strictEqual(on.upscaled, true);
    } finally {
      if (prev === undefined) delete process.env.UPSCALE_ARTWORK;
      else process.env.UPSCALE_ARTWORK = prev;
    }
  });

  test('mug print width is one side of the wrap; a blanket uses the full width', async () => {
    const png = await art(false);
    const sha = crypto.createHash('sha256').update(png).digest('hex');
    const seen = [];
    const upscale = async (buf, opts) => { seen.push(opts.printedWidth); return { buffer: buf, upscaled: false, info: 'disabled' }; };
    let stored = Buffer.from('x');
    const put = async () => 'https://blob.example/file.png';
    const render = async () => ({ buffer: stored, width: 10, height: 10, format: 'png', sha256: 'x' });
    const fetchImpl = async (url, opts) => (opts && opts.method === 'HEAD')
      ? { ok: true, headers: { get: () => String(stored.length) } }
      : { ok: true, arrayBuffer: async () => png };
    const catalog = {
      variantForSku: async () => ({ is_enabled: true, blueprint_id: 1, print_provider_id: 1, printify_variant_id: 1 }),
      printArea: async () => ({ width: 1000, height: 800, position: 'front' })
    };
    const design = {
      artwork: { sha256: sha, w: 40, h: 30 },
      background: { kind: 'solid', id: 'white' },
      pet: { w: 0.5, cx: 0.5, cy: 0.5, rot: 0 }
    };
    const item = { kind: 'design', line_id: 1, sku: 'S', design_id: 'd', artwork_url: 'https://cdn.shopify.com/a.png', design };
    const opts = { catalog, put, fetchImpl, hosts: ['cdn.shopify.com', 'blob.example'], render, upscale };
    await prepareDesignItems({ id: 1 }, [item], opts);
    await prepareDesignItems({ id: 1 }, [{ ...item, line_id: 2, design: { ...design, sides: 2 } }], opts);
    assert.deepStrictEqual(seen, [500, 250]);
  });
});
