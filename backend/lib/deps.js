'use strict';
// Production wiring shared by the webhook and the retry endpoint.
const { shopifyStore } = require('./shopify-store');
const { client } = require('./printify');
const { catalog } = require('./printify-catalog');
const { putPrintFile } = require('./storage');
const { prepareDesignItems } = require('./design-fulfillment');
const config = require('../config/printify-variants.json');

function productionDeps() {
  let cat;
  return {
    store: shopifyStore(),
    printify: client(),
    prepare: (order, items) => {
      cat = cat || catalog({ overrides: config.studio_products || {} });
      return prepareDesignItems(order, items, { catalog: cat, put: putPrintFile });
    }
  };
}
const hasDesignLines = order => ((order && order.line_items) || []).some(l => (l.properties || []).some(p => p.name === '_design' || p.name === '_design_unsigned'));

module.exports = { productionDeps, hasDesignLines };
