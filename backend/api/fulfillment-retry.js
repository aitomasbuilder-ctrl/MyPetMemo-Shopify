'use strict';
// POST /api/fulfillment-retry  { "order_id": 1234567890, "force": false }
// Header: Authorization: Bearer <ADMIN_API_SECRET>
// Re-runs fulfillment for a held order after the cause is fixed. Idempotent: an order that already
// has a Printify order is skipped. `force` releases a lock left by a run that died mid-way.
const crypto = require('node:crypto');
const { processPaidOrder } = require('../lib/process');
const { productionDeps } = require('../lib/deps');
const { send, readJson } = require('../lib/http');

function authorised(req, secret) {
  const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!secret || secret.length < 24 || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

async function handler(req, res, deps = {}) {
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  if (!authorised(req, deps.secret || process.env.ADMIN_API_SECRET)) return send(res, 401, { error: 'unauthorised' });
  try {
    const body = await readJson(req);
    const id = String(body.order_id || '');
    if (!/^\d{1,20}$/.test(id)) return send(res, 400, { error: 'order_id_required' });
    const wired = deps.store ? deps : productionDeps();
    const order = await wired.store.fetchOrder(id);
    if (!order) return send(res, 404, { error: 'order_not_found' });
    const record = await wired.store.get(id);
    if (body.force && record && record.claimed && !record.printify_order_id) await wired.store.set(id, { claimed: false });
    const mode = process.env.PRINTIFY_MODE === 'production' ? 'production' : 'draft';
    const result = await processPaidOrder(order, { store: wired.store, printify: wired.printify, prepare: wired.prepare, gateOptions: wired.gateOptions, mode });
    return send(res, 200, result);
  } catch (err) {
    console.error('fulfillment-retry failed', err.message);
    return send(res, 500, { error: 'retry_failed', message: err.message });
  }
}
module.exports = handler;
