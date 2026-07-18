import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  billingActionError,
  billingSupportHref,
  validatedPaddleRedirectUrl,
} from '../lib/paddle-billing-client.mjs';

test('billing redirects allow only approved Paddle or MineWiki checkout destinations', () => {
  const origin = 'https://minewiki.kr';
  assert.equal(validatedPaddleRedirectUrl('https://minewiki.kr/billing/checkout/_?txn=1', 'checkout', origin)?.startsWith(origin), true);
  assert.equal(validatedPaddleRedirectUrl('https://sandbox.pay.paddle.io/pay/test', 'checkout', origin)?.startsWith('https://sandbox.pay.paddle.io/'), true);
  assert.equal(validatedPaddleRedirectUrl('https://customer-portal.paddle.com/cpl_test?token=secret', 'portal', origin)?.startsWith('https://customer-portal.paddle.com/'), true);
  assert.equal(validatedPaddleRedirectUrl('https://sandbox-customer-portal.paddle.com/cpl_test?token=secret', 'portal', origin)?.startsWith('https://sandbox-customer-portal.paddle.com/'), true);
  assert.equal(validatedPaddleRedirectUrl('https://evil.example/billing/checkout', 'checkout', origin), null);
  assert.equal(validatedPaddleRedirectUrl('https://minewiki.kr/account', 'checkout', origin), null);
  assert.equal(validatedPaddleRedirectUrl('javascript:alert(1)', 'checkout', origin), null);
});

test('billing errors explain recovery without leaking provider identifiers', () => {
  assert.match(billingActionError(404, 'portal'), /구독/u);
  assert.match(billingActionError(409, 'checkout'), /결제 관리/u);
  assert.match(billingActionError(503, 'checkout'), /Paddle/u);
  assert.equal(billingActionError(500, 'checkout', 'x'.repeat(500)).length, 300);
});

test('billing support fallback uses fields the support form actually hydrates', () => {
  const href = new URL(billingSupportHref('server-id', 'handbook'), 'https://minewiki.kr');
  assert.equal(href.pathname, '/support/new');
  assert.equal(href.searchParams.get('category'), 'server_claim');
  assert.equal(href.searchParams.get('serverId'), 'server-id');
  assert.match(href.searchParams.get('subject') ?? '', /handbook/u);
  assert.match(href.searchParams.get('body') ?? '', /server-id/u);
});

test('layout plans bind checkout and portal actions to availability, CSRF, and expiry state', async () => {
  const source = await readFile(new URL('../components/wiki/server-wiki-layout-plans.tsx', import.meta.url), 'utf8');
  assert.match(source, /\/billing\/availability/u);
  assert.match(source, /\/billing\/\$\{action\}/u);
  assert.match(source, /await csrfHeaders\(\)/u);
  assert.match(source, /validatedPaddleRedirectUrl/u);
  assert.match(source, /openPaddleTransaction/u);
  assert.match(source, /body\.transactionId/u);
  assert.match(source, /portalAvailable/u);
  assert.match(source, /entitlementExpiresAt/u);
  assert.match(source, /Paddle 테스트 모드 · 실제 청구 없음/u);
  assert.doesNotMatch(source, /category=billing/u);
});

test('Paddle.js checkout validates environment-bound public tokens and provider transactions', async () => {
  const source = await readFile(new URL('../lib/paddle-checkout.ts', import.meta.url), 'utf8');
  assert.match(source, /NEXT_PUBLIC_PADDLE_CLIENT_TOKEN/u);
  assert.match(source, /TRANSACTION_ID_PATTERN/u);
  assert.match(source, /environment === 'production'.*startsWith\('live_'\)/su);
  assert.match(source, /paddle\.Checkout\.open/u);
  assert.match(source, /import\('@paddle\/paddle-js'\)/u);
  assert.doesNotMatch(source, /^import \{ initializePaddle/mu);
  assert.match(source, /transactionId,/u);
  assert.match(source, /return false/u);
});
