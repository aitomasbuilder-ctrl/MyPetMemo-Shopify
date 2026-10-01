'use strict';
// Returns an Admin API token. Two modes:
//  1) SHOPIFY_ADMIN_TOKEN set (legacy custom app, static token) -> used as is.
//  2) SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard app) -> client-credentials grant;
//     the token lasts ~24h, so it is cached and refreshed shortly before it expires.
function tokenProvider({ shop = process.env.SHOPIFY_SHOP_DOMAIN, staticToken = process.env.SHOPIFY_ADMIN_TOKEN,
  clientId = process.env.SHOPIFY_CLIENT_ID, clientSecret = process.env.SHOPIFY_CLIENT_SECRET, fetchImpl = fetch, now = Date.now } = {}) {
  let cached = null;
  return async function getToken() {
    if (staticToken) return staticToken;
    if (!clientId || !clientSecret) throw new Error('Set SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET');
    if (cached && cached.expiresAt - 60000 > now()) return cached.token;
    const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' })
    });
    if (!res.ok) throw new Error(`Shopify token request failed: ${res.status}`);
    const j = await res.json();
    cached = { token: j.access_token, expiresAt: now() + (j.expires_in || 86399) * 1000 };
    return cached.token;
  };
}
module.exports = { tokenProvider };
