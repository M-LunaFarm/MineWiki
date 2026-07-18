'use strict';

const BILLING_POLICY_VERSION = '2026-07-19-v2.0';
const BILLING_POLICY_EFFECTIVE_DATE = '2026-07-19';
const BILLING_POLICY_PATH = '/policies/billing';

const BILLING_PRODUCTS = Object.freeze([
  Object.freeze({
    productCode: 'server_wiki_handbook',
    layoutKey: 'handbook',
    displayName: 'Handbook',
    serviceScope: 'recurring_server_wiki_layout',
  }),
  Object.freeze({
    productCode: 'server_wiki_brand',
    layoutKey: 'brand',
    displayName: 'Brand',
    serviceScope: 'recurring_server_wiki_layout',
  }),
]);

function billingProductForLayout(layoutKey) {
  return BILLING_PRODUCTS.find((product) => product.layoutKey === layoutKey) ?? null;
}

module.exports = {
  BILLING_POLICY_VERSION,
  BILLING_POLICY_EFFECTIVE_DATE,
  BILLING_POLICY_PATH,
  BILLING_PRODUCTS,
  billingProductForLayout,
};
