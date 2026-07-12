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

test('rejects localhost hostname before DNS lookup', async () => {
  await assert.rejects(
    () => validateOutboundTarget('localhost', 25565),
    (error: unknown) =>
      error instanceof UnsafeEndpointError &&
      error.reason === 'invalid_host' &&
      error.message.includes('localhost')
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

for (const address of [
  '::',
  '::1',
  'fc00::1',
  'fd00::1',
  'fe80::1',
  'ff02::1',
  '2001:db8::1',
  '::ffff:127.0.0.1',
  '::ffff:10.0.0.1',
  '::ffff:169.254.169.254',
  '::ffff:192.168.1.1'
]) {
  test(`rejects non-public IPv6 target ${address}`, async () => {
    await assert.rejects(
      () => validateOutboundTarget(address, 25565, { allowIpv6: true }),
      (error: unknown) =>
        error instanceof UnsafeEndpointError && error.reason === 'private_address'
    );
  });
}

for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
  test(`allows public IPv6 target ${address}`, async () => {
    const result = await validateOutboundTarget(address, 25565, { allowIpv6: true });
    assert.deepEqual(result.addresses, [{ address, family: 6 }]);
  });
}

test('fails closed when enabled DNS results mix public IPv4 and private IPv6', async () => {
  await assert.rejects(
    () => validateOutboundTarget('mixed.example', 25565, {
      allowIpv6: true,
      lookup: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: 'fd00::1', family: 6 }
      ]
    }),
    (error: unknown) =>
      error instanceof UnsafeEndpointError && error.reason === 'private_address'
  );
});

test('ignores private IPv6 DNS records while IPv6 support is disabled', async () => {
  const result = await validateOutboundTarget('mixed.example', 25565, {
    lookup: async () => [
      { address: '8.8.8.8', family: 4 },
      { address: 'fd00::1', family: 6 }
    ]
  });
  assert.deepEqual(result.addresses, [{ address: '8.8.8.8', family: 4 }]);
});
