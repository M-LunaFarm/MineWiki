import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  BILLING_POLICY_VERSION,
  BILLING_PRODUCTS,
} from '@minewiki/schemas/billing-contract';

test('billing contract has unique recurring products for every paid server wiki layout', () => {
  assert.equal(BILLING_POLICY_VERSION, '2026-07-19-v2.0');
  assert.deepEqual(BILLING_PRODUCTS.map((product) => product.layoutKey), ['handbook', 'brand']);
  assert.equal(new Set(BILLING_PRODUCTS.map((product) => product.productCode)).size, BILLING_PRODUCTS.length);
  assert.equal(BILLING_PRODUCTS.every((product) => product.serviceScope === 'recurring_server_wiki_layout'), true);
});

test('current billing policy describes both products and the complete subscription lifecycle', async () => {
  const source = await readFile(new URL('../app/policies/billing/page.tsx', import.meta.url), 'utf8');
  for (const phrase of ['Handbook', 'Brand', '자동 갱신', '구독 취소', '권한이 종료', '결제 실패', 'Paddle']) {
    assert.match(source, new RegExp(phrase, 'u'));
  }
  assert.match(source, /BILLING_POLICY_VERSION/u);
  assert.match(source, /2026년 7월 19일부터 시행/u);
});
