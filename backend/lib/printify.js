'use strict';
// Thin Printify client. Token is read from env only. Orders are created as DRAFT:
// they are NOT sent to production unless sendToProduction() is called explicitly.
const BASE = 'https://api.printify.com/v1';

function client({ token = process.env.PRINTIFY_TOKEN, shopId = process.env.PRINTIFY_SHOP_ID, fetchImpl = fetch } = {}) {
  if (!token || !shopId) throw new Error('PRINTIFY_TOKEN and PRINTIFY_SHOP_ID are required');
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    if (!res.ok) { const e = new Error(`Printify ${res.status}: ${text.slice(0, 300)}`); e.status = res.status; throw e; }
    return text ? JSON.parse(text) : {};
  };
  return {
    // external_id = Shopify order id → Printify itself rejects a second order with the same id.
    createDraftOrder: (order, items, config) => call('POST', `/shops/${shopId}/orders.json`, {
      external_id: String(order.id),
      label: `Shopify ${order.name}`,
      line_items: items.map(i => ({
        print_provider_id: config.printify.print_provider_id,
        blueprint_id: config.printify.blueprint_id,
        variant_id: i.printify_variant_id,
        print_areas: { [config.printify.print_position]: i.print_file_url },
        quantity: i.quantity
      })),
      shipping_method: 1,
      send_shipping_notification: false,
      address_to: shippingAddress(order)
    }),
    sendToProduction: id => call('POST', `/shops/${shopId}/orders/${id}/send_to_production.json`),
    getOrder: id => call('GET', `/shops/${shopId}/orders/${id}.json`)
  };
}

function shippingAddress(order) {
  const a = order.shipping_address || {};
  return {
    first_name: a.first_name || '', last_name: a.last_name || '', email: order.email || '', phone: a.phone || '',
    country: a.country_code || '', region: a.province_code || '', address1: a.address1 || '', address2: a.address2 || '',
    city: a.city || '', zip: a.zip || ''
  };
}
module.exports = { client };
