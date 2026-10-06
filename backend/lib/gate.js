'use strict';
// Decides whether a Shopify order line may be sent to Printify.
// Returns { ok: true, items } or { ok: false, reasons: [...] }. Never throws on bad input.
// Two kinds of personalized lines:
//   ornament: the ornament product, with _approved and an uploaded _print_file_url
//   design:   any product personalized in the pet studio, with a signed _design token and an _artwork file
const config = require('../config/printify-variants.json');
const design = require('./design');

const PAID_STATUSES = new Set(['paid']);
const byShopifyVariant = new Map(config.variants.map(v => [v.shopify_variant_id, v]));

function props(line) {
  const out = {};
  for (const p of line.properties || []) out[p.name] = p.value;
  return out;
}

function ornamentLine(line, p, reasons) {
  const map = byShopifyVariant.get(String(line.variant_id));
  if (!map) { reasons.push(`variant_unmapped:${line.variant_id}`); return null; }
  if (p._approved !== 'true') reasons.push(`design_not_approved:${line.id}`);
  if (!p._print_file_url) reasons.push(`print_file_missing:${line.id}`);
  else if (!/^https:\/\//.test(p._print_file_url)) reasons.push(`print_file_not_https:${line.id}`);
  if (p._shape && p._shape !== map.shape) reasons.push(`shape_mismatch:${line.id}`);
  return { kind: 'ornament', line_id: line.id, printify_variant_id: map.printify_variant_id, quantity: 1, print_file_url: p._print_file_url, shape: map.shape };
}

function designLine(line, p, reasons, { verify, hosts }) {
  if (!p._design) { reasons.push(`design_unsigned:${line.id}`); return null; }
  let checked;
  try { checked = verify(p._design); }
  catch (e) { reasons.push(`${e.code === 'signing_not_configured' ? 'design_signing_not_configured' : 'design_invalid'}:${line.id}`); return null; }
  const d = checked.design;
  if (String(d.variant_id) !== String(line.variant_id)) reasons.push(`design_variant_mismatch:${line.id}`);
  if (String(d.product_id) !== String(line.product_id)) reasons.push(`design_product_mismatch:${line.id}`);
  if (!p._artwork) reasons.push(`artwork_missing:${line.id}`);
  else if (!design.allowedHost(p._artwork, hosts)) reasons.push(`artwork_host_not_allowed:${line.id}`);
  return {
    kind: 'design', line_id: line.id, quantity: Number(line.quantity) || 1, sku: line.sku || d.sku,
    design: d, design_id: checked.id, artwork_url: p._artwork
  };
}

function checkOrder(order, { verify = t => design.verify(t), hosts = design.defaultHosts() } = {}) {
  const reasons = [];
  if (!order || !PAID_STATUSES.has(order.financial_status)) reasons.push('order_not_paid');
  const items = [];
  for (const line of (order && order.line_items) || []) {
    const p = props(line);
    let item = null;
    if (p._design || p._design_unsigned) item = designLine(line, p, reasons, { verify, hosts });
    else if (String(line.product_id) === config.shopify_product_id) item = ornamentLine(line, p, reasons);
    else continue;
    if (item) items.push(item);
  }
  if (!items.length && !reasons.some(r => r.includes(':'))) return { ok: false, reasons: ['no_personalized_lines'] };
  return reasons.length ? { ok: false, reasons } : { ok: true, items };
}

module.exports = { checkOrder };
