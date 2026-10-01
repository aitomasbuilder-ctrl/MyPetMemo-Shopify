'use strict';
const crypto = require('node:crypto');
function verifyShopifyHmac(rawBody, headerValue, secret) {
  if (!secret || !headerValue) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest();
  let given; try { given = Buffer.from(headerValue, 'base64'); } catch { return false; }
  return given.length === digest.length && crypto.timingSafeEqual(given, digest);
}
module.exports = { verifyShopifyHmac };
