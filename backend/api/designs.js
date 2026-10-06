'use strict';
// POST /api/designs — approves a pet-studio design.
// Body: the design JSON from the storefront. Response: { id, token, design }.
// The token is stored on the cart line (_design) and is what the paid-order webhook trusts.
const { normalise, sign, DesignError } = require('../lib/design');
const { cors, send, readJson, limiter, clientIp } = require('../lib/http');

const allow = limiter({ max: Number(process.env.DESIGN_APPROVALS_PER_HOUR || 120), windowMs: 3600e3 });

async function handler(req, res) {
  if (!cors(req, res, 'POST, OPTIONS')) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
  if (!allow(clientIp(req))) return send(res, 429, { error: 'rate_limited', message: 'Too many approvals. Please wait a little and try again.' });
  try {
    const input = await readJson(req);
    const design = normalise(input.design || input);
    const { id, token } = sign(design);
    return send(res, 200, { id, token, design });
  } catch (err) {
    if (err instanceof DesignError) return send(res, err.code === 'signing_not_configured' ? 503 : 400, { error: err.code, message: err.message });
    if (err.status) return send(res, err.status, { error: err.message });
    console.error('designs failed', err);
    return send(res, 500, { error: 'server_error' });
  }
}
module.exports = handler;
