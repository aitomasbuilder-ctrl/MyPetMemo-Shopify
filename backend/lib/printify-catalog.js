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

  return { variantForSku, printArea };
}

module.exports = { catalog };
