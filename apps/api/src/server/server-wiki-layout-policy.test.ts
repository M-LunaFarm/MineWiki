import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveEffectiveServerWikiLayout,
  type ServerWikiLayoutEntitlementWindow,
} from './server-wiki-layout-policy';

const NOW = new Date('2026-07-17T12:00:00.000Z');

function entitlement(
  overrides: Partial<ServerWikiLayoutEntitlementWindow> = {},
): ServerWikiLayoutEntitlementWindow {
  return {
    layoutKey: 'brand',
    status: 'active',
    startsAt: new Date('2026-07-16T12:00:00.000Z'),
    expiresAt: new Date('2026-07-18T12:00:00.000Z'),
    ...overrides,
  };
}

test('premium server wiki layouts resolve only through a current matching entitlement', () => {
  assert.equal(resolveEffectiveServerWikiLayout('brand', [entitlement()], NOW), 'brand');
  assert.equal(resolveEffectiveServerWikiLayout('brand', [], NOW), 'docs');
  assert.equal(resolveEffectiveServerWikiLayout('brand', [entitlement({ status: 'revoked' })], NOW), 'docs');
  assert.equal(resolveEffectiveServerWikiLayout('brand', [entitlement({ startsAt: new Date('2026-07-18T00:00:00.000Z') })], NOW), 'docs');
  assert.equal(resolveEffectiveServerWikiLayout('brand', [entitlement({ expiresAt: NOW })], NOW), 'docs');
  assert.equal(resolveEffectiveServerWikiLayout('brand', [entitlement({ layoutKey: 'handbook' })], NOW), 'docs');
});

test('free and unknown persisted layouts safely resolve to docs', () => {
  assert.equal(resolveEffectiveServerWikiLayout('docs', [], NOW), 'docs');
  assert.equal(resolveEffectiveServerWikiLayout('legacy-premium', [entitlement()], NOW), 'docs');
});
