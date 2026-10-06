'use strict';
// Small helpers for the storefront-facing endpoints (CORS, JSON bodies, best-effort rate limit).
const MAX_BODY = 64 * 1024;

function allowedOrigins(env = process.env) {
  return String(env.STOREFRONT_ORIGINS || 'https://mypetmemo.com,https://www.mypetmemo.com')
    .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)
    .concat(env.SHOPIFY_SHOP_DOMAIN ? [`https://${env.SHOPIFY_SHOP_DOMAIN}`] : []);
}
function originAllowed(origin, env = process.env) {
  if (!origin) return false;
  if (allowedOrigins(env).includes(origin)) return true;
  return /^https:\/\/[a-z0-9-]+\.shopifypreview\.com$/.test(origin); // theme preview links
}

/** Applies CORS headers. Returns false (and ends the response) for preflight or forbidden origins. */
function cors(req, res, methods = 'GET, POST, OPTIONS') {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  } else if (origin) {
    send(res, 403, { error: 'origin_not_allowed' });
    return false;
  }
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return false; }
  return true;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw Object.assign(new Error('body_too_large'), { status: 413 }); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}

// Per-instance limiter: protects against accidental loops, not a determined attacker.
function limiter({ max, windowMs }) {
  const hits = new Map();
  return key => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    list.push(now); hits.set(key, list);
    if (hits.size > 5000) hits.clear();
    return list.length <= max;
  };
}
const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

module.exports = { cors, send, readJson, limiter, clientIp, originAllowed };
