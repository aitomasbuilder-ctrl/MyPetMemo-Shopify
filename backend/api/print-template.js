'use strict';
// GET /api/print-template?sku=... — exact Printify print-area size for a Shopify variant,
// so the storefront preview uses the real print proportions. Cached at the edge for a day.
const { catalog } = require('../lib/printify-catalog');
const { cors, send } = require('../lib/http');
const config = require('../config/printify-variants.json');

let cat;
async function handler(req, res, deps = {}) {
  if (!cors(req, res, 'GET, OPTIONS')) return;
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const sku = new URL(req.url, 'http://x').searchParams.get('sku');
  if (!sku || !/^[\w.-]{1,64}$/.test(sku)) return send(res, 400, { error: 'sku_required' });
  try {
    cat = deps.catalog || cat || catalog({ overrides: config.studio_products || {} });
    const mapping = await cat.variantForSku(sku);
    const area = await cat.printArea(mapping);
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ sku, width: area.width, height: area.height, position: area.position, title: mapping.title }));
  } catch (err) {
    console.error('print-template failed', err.message);
    return send(res, /not_found/.test(err.message) ? 404 : 502, { error: 'template_unavailable' });
  }
}
module.exports = handler;
