'use strict';
// Printful client and EU blanket router.
// EU blanket orders are made by Printful in Europe (fleece "Throw Blanket") instead of by the shop's
// US Printify provider: cheaper, faster, and no EU import duty. Everything else stays on Printify.
// Off unless PRINTFUL_API_TOKEN is set (and PRINTFUL_BLANKETS is not 'off').
// Orders are created as Printful DRAFTS (confirm=false): nothing is made or charged until
// confirmOrder() is called, which only happens when PRINTIFY_MODE=production.
const BASE = 'https://api.printful.com';

const EU = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
// Printify blueprints of our flat photo blankets (sherpa / fleece). The hooded blanket is not routed.
const DEFAULT_BLUEPRINTS = [238, 522, 918, 1120, 1385, 5346];

function enabled(env = process.env) {
  return Boolean(env.PRINTFUL_API_TOKEN) && env.PRINTFUL_BLANKETS !== 'off';
}

// "50″ × 60″" / '60" x 80"' / '127 × 152 cm (50 × 60 in)' -> '50x60' (inches, small side first)
function sizeKey(title) {
  const t = String(title || '').replace(/[″”"]/g, '"');
  const inch = t.match(/(\d{2})\s*"?\s*[x×]\s*(\d{2})\s*(?:"|in\b)/i) || t.match(/\b(\d{2})\s*[x×]\s*(\d{2})\b/);
  if (!inch) return null;
  const a = Number(inch[1]), b = Number(inch[2]);
  return `${Math.min(a, b)}x${Math.max(a, b)}`;
}

function client({ token = process.env.PRINTFUL_API_TOKEN, storeId = process.env.PRINTFUL_STORE_ID, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('PRINTFUL_API_TOKEN is required');
  const call = async (method, path, body) => {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'MyPetMemo-fulfillment' };
    if (storeId) headers['X-PF-Store-Id'] = String(storeId);
    const res = await fetchImpl(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) { const e = new Error(`Printful ${res.status}: ${text.slice(0, 300)}`); e.status = res.status; throw e; }
    const json = text ? JSON.parse(text) : {};
    return json.result !== undefined ? json.result : json;
  };
  return {
    call,
    // external_id = Shopify order id, so Printful rejects a second order for the same Shopify order.
    createDraftOrder: (order, items) => call('POST', '/orders?confirm=false', {
      external_id: String(order.id).slice(0, 32),
      shipping: 'STANDARD',
      recipient: recipient(order),
      items: items.map(i => ({
        variant_id: i.printful_variant_id,
        quantity: i.quantity,
        name: i.name || 'Personalized pet blanket',
        files: [{ type: 'default', url: i.print_file_url }]
      }))
    }),
    confirmOrder: id => call('POST', `/orders/${id}/confirm`)
  };
}

function recipient(order) {
  const a = order.shipping_address || {};
  return {
    name: [a.first_name, a.last_name].filter(Boolean).join(' ') || a.name || '',
    company: a.company || undefined,
    address1: a.address1 || '', address2: a.address2 || undefined,
    city: a.city || '', state_code: a.province_code || undefined,
    country_code: a.country_code || '', zip: a.zip || '',
    email: order.email || undefined, phone: a.phone || undefined
  };
}

// Picks the Printful blanket variant and print-file size for a Printify blanket line going to the EU.
// Returns null (stay on Printify) when the line is not a flat blanket, the size is not offered, or the
// print shape differs by more than 3% (the customer approved the design in the Printify shape).
function blanketRouter({ api, env = process.env } = {}) {
  const blueprints = new Set((env.PRINTFUL_BLANKET_BLUEPRINTS ? env.PRINTFUL_BLANKET_BLUEPRINTS.split(',') : DEFAULT_BLUEPRINTS).map(Number));
  let product = null;

  async function load() {
    if (product) return product;
    let id = Number(env.PRINTFUL_BLANKET_PRODUCT_ID) || null;
    if (!id) {
      const list = await api.call('GET', '/products');
      const hit = (list || []).find(p => /throw blanket/i.test(`${p.title} ${p.model} ${p.type_name}`) && !/sherpa|hood|baby/i.test(`${p.title} ${p.model}`) && !p.is_discontinued);
      if (!hit) throw new Error('printful_blanket_product_not_found');
      id = hit.id;
    }
    const [info, files] = await Promise.all([api.call('GET', `/products/${id}`), api.call('GET', `/mockup-generator/printfiles/${id}`)]);
    const printfiles = new Map((files.printfiles || []).map(f => [f.printfile_id, f]));
    const bySize = new Map();
    for (const v of info.variants || []) {
      const key = sizeKey(v.size || v.name);
      if (!key || v.in_stock === false) continue;
      const vp = (files.variant_printfiles || []).find(x => x.variant_id === v.id);
      const pf = vp && printfiles.get((vp.placements || {}).default);
      if (pf && pf.width > 0 && pf.height > 0) bySize.set(key, { variant_id: v.id, width: pf.width, height: pf.height });
    }
    product = { id, bySize };
    return product;
  }

  return async function route(mapping, area, countryCode) {
    if (!enabled(env)) return null;
    if (!EU.has(String(countryCode || '').toUpperCase())) return null;
    if (!mapping || !blueprints.has(Number(mapping.blueprint_id))) return null;
    const key = sizeKey(mapping.title);
    if (!key) return null;
    try {
      const p = await load();
      const v = p.bySize.get(key);
      if (!v) return null;
      // The design is rendered in the orientation the customer saw (w x h) and turned 90° when
      // Printful's print file is the other way round.
      const rotate = (area.height >= area.width) !== (v.height >= v.width);
      const w = rotate ? v.height : v.width, h = rotate ? v.width : v.height;
      const want = area.width / area.height;
      if (Math.abs(w / h - want) > 0.03 * want) { console.warn('printful_shape_mismatch', key, v.width, v.height, area.width, area.height); return null; }
      return { printful_variant_id: v.variant_id, width: w, height: h, rotate, size: key };
    } catch (err) {
      console.warn('printful_routing_skipped', err.message);
      return null;
    }
  };
}

module.exports = { client, blanketRouter, enabled, sizeKey, EU };
