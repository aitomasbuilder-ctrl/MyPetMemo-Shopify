'use strict';
// Decides whether a Shopify order line may be sent to Printify.
// Returns { ok: true, items } or { ok: false, reasons: [...] }. Never throws on bad input.
const config = require('../config/printify-variants.json');

const PAID_STATUSES = new Set(['paid']);
const byShopifyVariant = new Map(config.variants.map(v => [v.shopify_variant_id, v]));

function props(line) {
  const out = {};
  for (const p of line.properties || []) out[p.name] = p.value;
  return out;
}

function checkOrder(order) {
  const reasons = [];
  if (!order || !PAID_STATUSES.has(order.financial_status)) reasons.push('order_not_paid');
  const items = [];
  for (const line of (order && order.line_items) || []) {
    if (String(line.product_id) !== config.shopify_product_id) continue;
    const p = props(line);
    const map = byShopifyVariant.get(String(line.variant_id));
    if (!map) { reasons.push(`variant_unmapped:${line.variant_id}`); continue; }
    if (p._approved !== 'true') reasons.push(`design_not_approved:${line.id}`);
    if (!p._print_file_url) reasons.push(`print_file_missing:${line.id}`);
    else if (!/^https:\/\//.test(p._print_file_url)) reasons.push(`print_file_not_https:${line.id}`);
    if (p._shape && p._shape !== map.shape) reasons.push(`shape_mismatch:${line.id}`);
    items.push({ line_id: line.id, printify_variant_id: map.printify_variant_id, quantity: 1, print_file_url: p._print_file_url, shape: map.shape });
  }
  if (!items.length) reasons.push('no_ornament_lines');
  return reasons.length ? { ok: false, reasons } : { ok: true, items };
}

module.exports = { checkOrder };
