import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CidrValidationError,
  cidrContains,
  normalizeIpAddress,
  normalizeIpOrCidr
} from '../src/cidr';

test('normalizes IPv4 and IPv6 networks to their canonical network address', () => {
  assert.deepEqual(normalizeIpOrCidr('192.0.2.129/24'), {
    cidr: '192.0.2.0/24',
    address: '192.0.2.0',
    family: 4,
    prefixLength: 24,
    networkBytes: [192, 0, 2, 0]
  });
  const ipv6 = normalizeIpOrCidr('2001:0db8:0001::abcd/48');
  assert.equal(ipv6.cidr, '2001:db8:1::/48');
  assert.equal(ipv6.family, 6);
});

test('normalizes single addresses and IPv4-mapped IPv6 addresses', () => {
  assert.equal(normalizeIpAddress('2001:0db8::1'), '2001:db8::1');
  assert.equal(normalizeIpAddress('::ffff:192.0.2.10'), '192.0.2.10');
  assert.equal(normalizeIpOrCidr('192.0.2.10').cidr, '192.0.2.10/32');
});

test('checks IPv4 and IPv6 CIDR containment without mixing address families', () => {
  assert.equal(cidrContains('192.0.2.0/24', '192.0.2.255'), true);
  assert.equal(cidrContains('192.0.2.0/24', '192.0.3.1'), false);
  assert.equal(cidrContains('2001:db8::/32', '2001:db8:ffff::1'), true);
  assert.equal(cidrContains('2001:db8::/32', '192.0.2.1'), false);
});

test('rejects invalid addresses and missing CIDR prefixes when required', () => {
  assert.throws(() => normalizeIpOrCidr('999.1.2.3'), CidrValidationError);
  assert.throws(() => normalizeIpOrCidr('192.0.2.1', true), CidrValidationError);
});
