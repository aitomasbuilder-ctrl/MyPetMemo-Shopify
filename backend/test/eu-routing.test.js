'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { catalog } = require('../lib/printify-catalog');

// Blueprint 50 is made by a US provider (1), a Latvian provider (2) and a German provider (3).
// Provider 4 is in Poland but its print area has a different shape.
function fakeFetch(calls = []) {
  const routes = {
    '/catalog/print_providers/1.json': { title: 'US Print', location: { country: 'US' } },
    '/catalog/print_providers/2.json': { title: 'Riga Print', location: { country: 'LV' } },
    '/catalog/print_providers/3.json': { title: 'Berlin Print', location: { country: 'DE' } },
    '/catalog/print_providers/4.json': { title: 'Krakow Print', location: { country: 'PL' } },
    '/catalog/print_providers/9.json': { title: 'Printify Choice', location: { country: 'US' } },
    '/catalog/blueprints/50/print_providers.json': [{ id: 1 }, { id: 4 }, { id: 3 }, { id: 2 }],
    '/catalog/blueprints/50/print_providers/1/variants.json': { variants: [{ id: 101, title: '50″ × 60″', placeholders: [{ position: 'front', width: 6000, height: 7200 }] }] },
    '/catalog/blueprints/50/print_providers/2/variants.json': { variants: [{ id: 201, title: '50" × 60"', placeholders: [{ position: 'front', width: 5000, height: 6000 }] }] },
    '/catalog/blueprints/50/print_providers/3/variants.json': { variants: [{ id: 301, title: '50" × 60"', placeholders: [{ position: 'front', width: 6000, height: 7200 }] }] },
    '/catalog/blueprints/50/print_providers/4/variants.json': { variants: [{ id: 401, title: '50" × 60"', placeholders: [{ position: 'front', width: 6000, height: 6000 }] }] }
  };
  return async url => {
    const path = url.replace('https://api.printify.com/v1', '').replace(/\?.*$/, '');
    calls.push(path);
    const body = routes[path];
    return { ok: !!body, status: body ? 200 : 404, text: async () => JSON.stringify(body || {}) };
  };
}
const usMapping = { blueprint_id: 50, print_provider_id: 1, printify_variant_id: 101, title: '50″ × 60″', position: 'front', is_enabled: true };
const cat = calls => catalog({ token: 't', shopId: 's', fetchImpl: fakeFetch(calls) });

test('a Lithuanian order moves to the nearest EU provider with the same print shape', async () => {
  const c = cat();
  const routed = await c.regionalVariant(usMapping, 'LT');
  assert.equal(routed.print_provider_id, 2, 'Latvia is preferred over Germany; Poland is skipped because its print area has another shape');
  assert.equal(routed.printify_variant_id, 201);
  assert.equal(routed.region, 'eu:LV');
  assert.deepEqual(await c.printArea(routed), { position: 'front', width: 5000, height: 6000 }, 'the print file is rendered at the EU provider size');
});

test('orders outside the EU keep the shop provider and make no catalog calls', async () => {
  const calls = [];
  assert.equal(await cat(calls).regionalVariant(usMapping, 'US'), usMapping);
  assert.deepEqual(calls, []);
});

test('Printify Choice and EU providers are left alone', async () => {
  const c = cat();
  const choice = { ...usMapping, print_provider_id: 9 };
  assert.equal(await c.regionalVariant(choice, 'LT'), choice);
  const eu = { ...usMapping, print_provider_id: 3, printify_variant_id: 301 };
  assert.equal(await c.regionalVariant(eu, 'LT'), eu);
});

test('no matching EU variant or a catalog error keeps the shop provider', async () => {
  const c = cat();
  const other = { ...usMapping, title: '60″ × 80″' };
  assert.equal(await c.regionalVariant(other, 'LT'), other);
  const broken = { ...usMapping, blueprint_id: 77 };
  assert.equal(await c.regionalVariant(broken, 'LT'), broken);
});

test('routing can be switched off', async () => {
  process.env.PRINTIFY_EU_ROUTING = 'off';
  try { assert.equal(await cat().regionalVariant(usMapping, 'LT'), usMapping); }
  finally { delete process.env.PRINTIFY_EU_ROUTING; }
});
