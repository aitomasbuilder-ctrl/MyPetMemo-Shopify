'use strict';
// Vercel serverless function: Shopify webhook `orders/paid`.
const { verifyShopifyHmac } = require('../lib/hmac');
const { processPaidOrder } = require('../lib/process');
const { shopifyStore } = require('../lib/shopify-store');
const { client } = require('../lib/printify');

const readRaw = req => new Promise((resolve, reject) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); });

async function handler(req, res, deps = {}) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  const raw = await readRaw(req);
  const secret = deps.secret || process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!verifyShopifyHmac(raw, req.headers['x-shopify-hmac-sha256'], secret)) { res.statusCode = 401; return res.end('invalid signature'); }
  try {
    const order = JSON.parse(raw.toString('utf8'));
    // Production is OFF unless explicitly enabled. Default creates Printify drafts only.
    const mode = process.env.PRINTIFY_MODE === 'production' ? 'production' : 'draft';
    const result = await processPaidOrder(order, { store: deps.store || shopifyStore(), printify: deps.printify || client(), mode });
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(result));
  } catch (err) {
    console.error('orders-paid failed', err.message);
    res.statusCode = 500; return res.end('error'); // Shopify will retry; the lock prevents double submission
  }
}
module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
