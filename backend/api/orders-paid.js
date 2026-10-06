'use strict';
// Vercel serverless function: Shopify webhook `orders/paid`.
// Orders with pet-studio designs are acknowledged at once and processed in the background
// (rendering a full-size print file takes longer than Shopify's 5 second webhook timeout).
// Failures are recorded on the order (metafield mypetmemo.fulfillment + fulfillment hold) and can be
// re-run with /api/fulfillment-retry.
const { verifyShopifyHmac } = require('../lib/hmac');
const { processPaidOrder } = require('../lib/process');
const { productionDeps, hasDesignLines } = require('../lib/deps');

const readRaw = req => new Promise((resolve, reject) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); });

function background(promise, deps) {
  const wait = deps.waitUntil || (() => { try { return require('@vercel/functions').waitUntil; } catch { return null; } })();
  if (!wait) return false;
  wait(promise);
  return true;
}

async function handler(req, res, deps = {}) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
  const raw = await readRaw(req);
  const secret = deps.secret || process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!verifyShopifyHmac(raw, req.headers['x-shopify-hmac-sha256'], secret)) { res.statusCode = 401; return res.end('invalid signature'); }
  try {
    const order = JSON.parse(raw.toString('utf8'));
    // Production is OFF unless explicitly enabled. Default creates Printify drafts only.
    const mode = process.env.PRINTIFY_MODE === 'production' ? 'production' : 'draft';
    const wired = deps.store ? deps : { ...productionDeps(), ...deps };
    const run = () => processPaidOrder(order, { store: wired.store, printify: wired.printify, prepare: wired.prepare, gateOptions: wired.gateOptions, mode });
    if (hasDesignLines(order)) {
      const work = run().then(r => console.log('orders-paid', order.id, JSON.stringify(r)), e => console.error('orders-paid background failed', order.id, e.message));
      if (background(work, deps)) {
        res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ action: 'accepted' }));
      }
      await work;
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ action: 'processed' }));
    }
    const result = await run();
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(result));
  } catch (err) {
    console.error('orders-paid failed', err.message);
    res.statusCode = 500; return res.end('error'); // Shopify will retry; the lock prevents double submission
  }
}
module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
