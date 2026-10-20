'use strict';
// Finds the Printify product/variant behind a Shopify variant (by SKU, which Printify sets when it
// publishes) and the exact print-area size from the Printify catalog. Results are cached per instance.
const BASE = 'https://api.printify.com/v1';

function catalog({ token = process.env.PRINTIFY_TOKEN, shopId = process.env.PRINTIFY_SHOP_ID, fetchImpl = fetch, overrides = {} } = {}) {
  if (!token || !shopId) throw new Error('PRINTIFY_TOKEN and PRINTIFY_SHOP_ID are required');
  const get = async path => {
    const res = await fetchImpl(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'MyPetMemo-fulfillment' } });
    const text = await res.text();
    if (!res.ok) { const e = new Error(`Printify ${res.status}: ${text.slice(0, 200)}`); e.status = res.status; throw e; }
    return JSON.parse(text);
  };
  const bySku = new Map();
  const placeholders = new Map();
  let scanned = false;

  const remember = product => {
    const position = ((product.print_areas || [])[0]?.placeholders || [])[0]?.position || 'front';
    for (const v of product.variants || []) {
      if (!v.sku) continue;
      bySku.set(String(v.sku), {
        printify_product_id: product.id, blueprint_id: product.blueprint_id, print_provider_id: product.print_provider_id,
        printify_variant_id: v.id, title: v.title, position, is_enabled: v.is_enabled !== false
      });
    }
  };

  // overrides: { [sku]: { printify_product_id } } skips the shop scan for known products.
  async function variantForSku(sku) {
    const key = String(sku || '');
    if (!key) throw new Error('sku_missing');
    if (bySku.has(key)) return bySku.get(key);
    const known = overrides[key];
    if (known && known.printify_product_id) {
      remember(await get(`/shops/${shopId}/products/${known.printify_product_id}.json`));
      if (bySku.has(key)) return bySku.get(key);
    }
    if (!scanned) {
      for (let page = 1; page <= 20; page++) {
        const list = await get(`/shops/${shopId}/products.json?limit=50&page=${page}`);
        (list.data || []).forEach(remember);
        if (bySku.has(key) || !list.next_page_url || page >= (list.last_page || page)) break;
      }
      scanned = true;
    }
    if (!bySku.has(key)) throw new Error(`printify_variant_not_found:${key}`);
    return bySku.get(key);
  }

  async function printArea(mapping) {
    const k = `${mapping.blueprint_id}/${mapping.print_provider_id}`;
    if (!placeholders.has(k)) {
      const json = await get(`/catalog/blueprints/${mapping.blueprint_id}/print_providers/${mapping.print_provider_id}/variants.json?show-out-of-stock=1`);
      placeholders.set(k, new Map((json.variants || []).map(v => [v.id, v.placeholders || []])));
    }
    const list = placeholders.get(k).get(mapping.printify_variant_id) || [];
    const p = list.find(x => x.position === mapping.position) || list[0];
    if (!p || !(p.width > 0 && p.height > 0)) throw new Error(`print_area_unknown:${mapping.printify_variant_id}`);
    return { position: p.position, width: Math.round(p.width), height: Math.round(p.height) };
  }

  const providerCountry = new Map();
  async function countryOf(id) {
    if (!providerCountry.has(id)) {
      const p = await get(`/catalog/print_providers/${id}.json`);
      providerCountry.set(id, { country: String((p.location && p.location.country) || '').toUpperCase(), title: p.title || '' });
    }
    return providerCountry.get(id);
  }

  // Orders shipping inside the EU go to an EU print provider on the same blueprint when one offers the
  // same variant with the same print-area shape; otherwise the shop's own provider is kept. EU-made
  // parcels avoid the EU import duty and VAT collection on delivery, and arrive sooner.
  async function regionalVariant(mapping, countryCode) {
    const dest = String(countryCode || '').toUpperCase();
    if (!EU.has(dest) || process.env.PRINTIFY_EU_ROUTING === 'off') return mapping;
    try {
      const current = await countryOf(mapping.print_provider_id);
      if (EU.has(current.country) || /choice/i.test(current.title)) return mapping; // already EU, or Printify routes it itself
      const area = await printArea(mapping);
      const providers = await get(`/catalog/blueprints/${mapping.blueprint_id}/print_providers.json`);
      const candidates = [];
      for (const p of providers || []) {
        if (p.id === mapping.print_provider_id) continue;
        const { country } = await countryOf(p.id);
        if (EU.has(country)) candidates.push({ id: p.id, rank: rankFor(country, dest), country });
      }
      candidates.sort((a, b) => a.rank - b.rank);
      const want = normTitle(mapping.title);
      for (const c of candidates) {
        const json = await get(`/catalog/blueprints/${mapping.blueprint_id}/print_providers/${c.id}/variants.json`);
        const v = (json.variants || []).find(x => normTitle(x.title) === want);
        if (!v) continue;
        const p = (v.placeholders || []).find(x => x.position === area.position);
        if (!p || !(p.width > 0 && p.height > 0)) continue;
        if (Math.abs(p.width / p.height - area.width / area.height) > 0.02 * (area.width / area.height)) continue;
        const routed = { ...mapping, print_provider_id: c.id, printify_variant_id: v.id, region: `eu:${c.country}` };
        placeholders.set(`${mapping.blueprint_id}/${c.id}`, new Map((json.variants || []).map(x => [x.id, x.placeholders || []])));
        return routed;
      }
    } catch (err) {
      console.warn('eu_routing_skipped', mapping.blueprint_id, err.message);
    }
    return mapping;
  }

  return { variantForSku, printArea, regionalVariant };
}

const EU = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
// Closest production first for Baltic and Nordic orders; elsewhere any EU provider is fine.
const NEAR = ['LT', 'LV', 'EE', 'PL', 'FI', 'DE', 'CZ', 'DK', 'SE', 'NL'];
const rankFor = (country, dest) => (country === dest ? -1 : NEAR.includes(country) ? NEAR.indexOf(country) : NEAR.length);
const normTitle = t => String(t || '').toLowerCase().replace(/[″”"]/g, '"').replace(/\s+/g, ' ').trim();

module.exports = { catalog };
