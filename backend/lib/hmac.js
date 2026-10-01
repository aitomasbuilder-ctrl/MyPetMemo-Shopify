'use strict';
const crypto = require('node:crypto');
// `secret` may hold several comma-separated secrets (e.g. app client secret and the store webhook signing key).
function verifyShopifyHmac(rawBody, headerValue, secret) {
  if (!secret || !headerValue) return false;
  const secrets = String(secret).split(',').map(x => x.trim()).filter(Boolean);
  return secrets.some(sec => verifyOne(rawBody, headerValue, sec));
}
function verifyOne(rawBody, headerValue, secret) {
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let given; try { given = Buffer.from(headerValue, 'base64'); } catch { return false; }
  return given.length === digest.length && crypto.timingSafeEqual(given, digest);
}
module.exports = { verifyShopifyHmac };
