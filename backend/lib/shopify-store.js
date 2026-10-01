'use strict';
// Persists per-order fulfillment state in an ORDER METAFIELD (mypetmemo.fulfillment, JSON),
// so it is visible in the Shopify admin and needs no separate database.
// claim() uses compareDigest, so two concurrent webhooks cannot both win the lock.
const { tokenProvider } = require('./shopify-auth');
const NS = 'mypetmemo', KEY = 'fulfillment';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-07';

const Q_STATE = `query OrderState($id: ID!) { order(id: $id) { id name metafield(namespace: "${NS}", key: "${KEY}") { value compareDigest } fulfillmentOrders(first: 10) { nodes { id status } } } }`;
const M_SET = `mutation SetState($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { id compareDigest } userErrors { field message code } } }`;
const M_HOLD = `mutation Hold($id: ID!, $hold: FulfillmentOrderHoldInput!) { fulfillmentOrderHold(id: $id, fulfillmentHold: $hold) { fulfillmentHold { id } userErrors { field message } } }`;

function shopifyStore({ shop = process.env.SHOPIFY_SHOP_DOMAIN, token, getToken, fetchImpl = fetch } = {}) {
  if (!shop) throw new Error('SHOPIFY_SHOP_DOMAIN is required');
  const tokenFn = getToken || (token ? async () => token : tokenProvider({ shop, fetchImpl }));
  const gid = id => `gid://shopify/Order/${id}`;
  const gql = async (query, variables) => {
    const res = await fetchImpl(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await tokenFn() }, body: JSON.stringify({ query, variables })
    });
    if (!res.ok) throw new Error(`Shopify ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}`);
    return json.data;
  };
  const read = async id => {
    const d = await gql(Q_STATE, { id: gid(id) });
    const mf = d.order && d.order.metafield;
    return { record: mf ? JSON.parse(mf.value) : null, digest: mf ? mf.compareDigest : null, fulfillmentOrders: d.order ? d.order.fulfillmentOrders.nodes : [] };
  };
  const write = async (id, record, digest) => {
    const input = { ownerId: gid(id), namespace: NS, key: KEY, type: 'json', value: JSON.stringify({ ...record, updated_at: new Date().toISOString() }) };
    input.compareDigest = digest; // null = create only if absent
    const d = await gql(M_SET, { metafields: [input] });
    const errs = d.metafieldsSet.userErrors;
    if (errs.length) { const e = new Error(errs.map(x => x.message).join('; ')); e.stale = errs.some(x => x.code === 'STALE_OBJECT'); throw e; }
  };
  return {
    get: async id => (await read(id)).record,
    claim: async id => {
      const { record, digest } = await read(id);
      if (record && record.claimed) return false;
      try { await write(id, { ...(record || {}), claimed: true }, digest); return true; }
      catch (e) { if (e.stale) return false; throw e; }
    },
    set: async (id, patch) => { const { record, digest } = await read(id); await write(id, { ...(record || {}), ...patch }, digest); },
    // Keeps the order from being fulfilled by any app until a human releases the hold.
    applyHold: async (id, reason) => {
      const { fulfillmentOrders } = await read(id);
      for (const fo of fulfillmentOrders.filter(f => f.status === 'OPEN')) {
        const d = await gql(M_HOLD, { id: fo.id, hold: { reason: 'OTHER', reasonNotes: String(reason).slice(0, 250) } });
        const errs = d.fulfillmentOrderHold.userErrors;
        if (errs.length) throw new Error(errs.map(x => x.message).join('; '));
      }
    }
  };
}
module.exports = { shopifyStore, Q_STATE, M_SET, M_HOLD };
