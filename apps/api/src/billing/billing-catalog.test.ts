import test from 'node:test';
import assert from 'node:assert/strict';
import { BillingCatalog, billingCatalogEntry } from './billing-catalog';

test('billing catalog maps only configured handbook and brand prices', () => {
  const catalog = new BillingCatalog(config({
    PADDLE_MODE: 'live',
    PADDLE_PRICE_HANDBOOK: 'pri_handbook',
    PADDLE_PRICE_BRAND: 'pri_brand',
  }) as never);

  assert.deepEqual(catalog.listBillableLayouts(), ['handbook', 'brand']);
  assert.equal(catalog.getProviderPriceId('handbook'), 'pri_handbook');
  assert.equal(catalog.getProviderPriceId('brand'), 'pri_brand');
  assert.equal(catalog.findLayoutByProviderPriceId('pri_handbook'), 'handbook');
  assert.equal(catalog.findLayoutByProviderPriceId('pri_unknown'), null);
  assert.deepEqual(catalog.getProduct('handbook'), {
    productCode: 'server_wiki_handbook',
    layoutKey: 'handbook',
    displayName: 'Handbook',
    serviceScope: 'recurring_server_wiki_layout',
  });
  assert.deepEqual(
    billingCatalogEntry(config({
      PADDLE_MODE: 'live',
      PADDLE_PRICE_HANDBOOK: 'pri_handbook',
    }) as never, 'handbook'),
    { layoutKey: 'handbook', priceId: 'pri_handbook' },
  );
});

test('billing catalog never loads provider prices outside live mode', () => {
  const catalog = new BillingCatalog(config({
    PADDLE_MODE: 'shadow',
    PADDLE_PRICE_HANDBOOK: 'pri_should_not_load',
    PADDLE_PRICE_BRAND: 'pri_should_not_load_either',
  }) as never);

  assert.equal(catalog.isLive(), false);
  assert.deepEqual(catalog.listBillableLayouts(), ['handbook', 'brand']);
  assert.equal(catalog.findLayoutByProviderPriceId('pri_should_not_load'), null);
  assert.throws(() => catalog.getProviderPriceId('handbook'), /not live/);
  assert.throws(
    () => billingCatalogEntry(config({ PADDLE_MODE: 'shadow' }) as never, 'handbook'),
    /not live/,
  );
});

function config(values: Record<string, string>) {
  return {
    get(key: string, fallback?: string) {
      return values[key] ?? fallback;
    },
  };
}
