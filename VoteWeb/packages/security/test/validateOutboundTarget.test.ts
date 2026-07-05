import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnsafeEndpointError, validateOutboundTarget } from '../src/index.js';

test('allows outbound target to public IPv4 address', async () => {
  const result = await validateOutboundTarget('8.8.8.8', 19132, {
    label: 'Public DNS',
    allowedPorts: [19132, 25565]
  });
  assert.equal(result.host, '8.8.8.8');
  assert.equal(result.port, 19132);
  assert.equal(result.addresses.length, 1);
  assert.equal(result.addresses[0]?.address, '8.8.8.8');
});

test('rejects loopback IPv4 target', async () => {
  await assert.rejects(
    () => validateOutboundTarget('127.0.0.1', 25565),
    (error: unknown) =>
      error instanceof UnsafeEndpointError &&
      error.reason === 'private_address' &&
      error.message.includes('127.0.0.1')
  );
});

test('rejects RFC1918 private IPv4 target', async () => {
  await assert.rejects(
    () => validateOutboundTarget('192.168.1.10', 25565),
    (error: unknown) =>
      error instanceof UnsafeEndpointError &&
      error.reason === 'private_address' &&
      error.message.includes('192.168.1.10')
  );
});

test('rejects metadata service IPs', async () => {
  await assert.rejects(
    () => validateOutboundTarget('169.254.169.254', 80, { label: 'Metadata endpoint' }),
    (error: unknown) =>
      error instanceof UnsafeEndpointError &&
      error.reason === 'private_address' &&
      error.message.includes('169.254.169.254')
  );
});

test('rejects hosts containing path separators', async () => {
  await assert.rejects(
    () => validateOutboundTarget('example.com/..', 25565),
    (error: unknown) =>
      error instanceof UnsafeEndpointError &&
      error.reason === 'invalid_host' &&
      error.message.includes('host must not include path separators')
  );
});

test('rejects ports outside allowlist', async () => {
  await assert.rejects(
    () => validateOutboundTarget('8.8.8.8', 25566, { allowedPorts: [25565] }),
    (error: unknown) =>
      error instanceof UnsafeEndpointError &&
      error.reason === 'invalid_port' &&
      error.message.includes('allowlist')
  );
});

test('allows DNS host when IPv4 and IPv6 records coexist', async () => {
  const result = await validateOutboundTarget('google.com', 25565, {
    label: 'Mixed DNS records'
  });
  assert.ok(result.addresses.some((address) => address.family === 4));
  assert.equal(result.addresses.some((address) => address.family === 6), false);
});

test('rejects DNS host when only IPv6 records are available', async () => {
  await assert.rejects(
    () => validateOutboundTarget('ipv6.google.com', 25565, { label: 'IPv6 only host' }),
    (error: unknown) =>
      error instanceof UnsafeEndpointError &&
      error.reason === 'ipv6_not_allowed' &&
      error.message.includes('IPv6 is not allowed')
  );
});
