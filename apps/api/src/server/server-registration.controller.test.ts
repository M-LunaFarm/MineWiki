import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerController, serverProfilePayloadSchema } from './server.controller';
import { normalizeMinecraftServerHost } from '@minewiki/minecraft';

test('Minecraft server hosts are canonicalized without accepting URLs or embedded ports', () => {
  assert.equal(normalizeMinecraftServerHost(' PLAY.Example.COM. '), 'play.example.com');
  assert.equal(
    normalizeMinecraftServerHost('마인크래프트.한국'),
    'xn--hj2bm5bm1v7vib0c1ue.xn--3e0b707e',
  );
  assert.throws(() => normalizeMinecraftServerHost('https://play.example.com'));
  assert.throws(() => normalizeMinecraftServerHost('play.example.com:25565'));
  assert.throws(() => normalizeMinecraftServerHost('user@play.example.com'));
  assert.throws(() => normalizeMinecraftServerHost('localhost'));
  assert.throws(() => normalizeMinecraftServerHost('minecraft.local'));
});

test('public registration records a pending registrant without granting ownership', async () => {
  let registration: Record<string, unknown> | null = null;
  let captchaRequest: { token?: string | null; remoteIp?: string } | null = null;
  const controller = new ServerController(
    {
      register: async (payload: Record<string, unknown>) => {
        registration = payload;
        return { id: 'server-1' };
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      verifyCaptcha: async (token?: string | null, remoteIp?: string) => {
        captchaRequest = { token, remoteIp };
        return { success: true };
      },
    } as never,
  );

  await controller.register(
    {
      name: '  Pending Server  ',
      joinHost: '  play.example.com  ',
      joinPort: 25565,
      edition: 'java',
      supportedVersions: [' 1.21.1 ', '1.21.1'],
      tags: [' survival ', 'survival'],
      shortDescription: '  Ownership verification pending  ',
      longDescription: '  A server waiting for DNS or MOTD ownership verification.  ',
      websiteUrl: '  https://example.com/server  ',
      discordUrl: null,
      captchaToken: 'verified-captcha-token',
    },
    { userId: '11111111-1111-4111-8111-111111111111' } as never,
    { clientIp: '203.0.113.10' } as never,
  );

  assert.deepEqual(captchaRequest, {
    token: 'verified-captcha-token',
    remoteIp: '203.0.113.10',
  });
  assert.equal(
    registration?.registrantAccountId,
    '11111111-1111-4111-8111-111111111111',
  );
  assert.deepEqual(registration, {
    name: 'Pending Server',
    joinHost: 'play.example.com',
    joinPort: 25565,
    edition: 'java',
    supportedVersions: ['1.21.1'],
    tags: ['survival'],
    shortDescription: 'Ownership verification pending',
    longDescription: 'A server waiting for DNS or MOTD ownership verification.',
    websiteUrl: 'https://example.com/server',
    discordUrl: null,
    registrantAccountId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal('ownerAccountId' in (registration ?? {}), false);
});

test('public registration fails closed before persistence when CAPTCHA is rejected', async () => {
  let registrations = 0;
  const controller = new ServerController(
    { register: async () => { registrations += 1; return {}; } } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { verifyCaptcha: async () => ({ success: false, errors: ['missing_token'] }) } as never,
  );

  await assert.rejects(
    controller.register({
      name: 'Pending Server',
      joinHost: 'play.example.com',
      joinPort: 25565,
      edition: 'java',
      supportedVersions: ['1.21.1'],
      tags: [],
      shortDescription: 'Ownership verification pending',
      longDescription: 'A server waiting for ownership verification.',
    }, { userId: 'account-1' } as never, { clientIp: '203.0.113.10' } as never),
    /CAPTCHA/u,
  );
  assert.equal(registrations, 0);
});

test('public registration rejects oversized tenant content before persistence', async () => {
  let registrations = 0;
  const controller = new ServerController(
    { register: async () => { registrations += 1; return {}; } } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { verifyCaptcha: async () => ({ success: true }) } as never,
  );

  await assert.rejects(
    controller.register({
      name: 'Pending Server',
      joinHost: 'play.example.com',
      joinPort: 25565,
      edition: 'java',
      supportedVersions: ['v'.repeat(33)],
      tags: ['survival'],
      shortDescription: 'Ownership verification pending',
      longDescription: 'x'.repeat(20_001),
      websiteUrl: `https://example.com/${'x'.repeat(2_048)}`,
    }, { userId: 'account-1' } as never, { clientIp: '203.0.113.10' } as never),
  );
  assert.equal(registrations, 0);
});

test('server external links reject executable and non-web URL schemes', async () => {
  let registrations = 0;
  const controller = new ServerController(
    { register: async () => { registrations += 1; return {}; } } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { verifyCaptcha: async () => ({ success: true }) } as never,
  );

  for (const websiteUrl of ['javascript:alert(1)', 'data:text/html,unsafe', 'ftp://example.com']) {
    await assert.rejects(
      controller.register({
        name: 'Pending Server',
        joinHost: 'play.example.com',
        joinPort: 25565,
        edition: 'java',
        supportedVersions: ['1.21.1'],
        tags: ['survival'],
        shortDescription: 'Ownership verification pending',
        longDescription: 'A server waiting for ownership verification.',
        websiteUrl,
      }, { userId: 'account-1' } as never, { clientIp: '203.0.113.10' } as never),
      /http.*https/u,
    );
    assert.throws(
      () => serverProfilePayloadSchema.parse({
        name: 'Pending Server',
        tags: ['survival'],
        shortDescription: 'Ownership verification pending',
        longDescription: 'A server waiting for ownership verification.',
        websiteUrl,
        discordUrl: null,
      }),
      /http.*https/u,
    );
  }
  assert.equal(registrations, 0);
});

test('server profile updates are owner-scoped, strict, trimmed, and bounded', async () => {
  const serverId = '22222222-2222-4222-8222-222222222222';
  const accountId = '11111111-1111-4111-8111-111111111111';
  let update: Record<string, unknown> | null = null;
  const controller = new ServerController(
    {
      updateProfile: async (_id: string, payload: Record<string, unknown>) => {
        update = payload;
        return { id: serverId };
      },
    } as never,
    { isOwner: async () => true } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await controller.updateProfile(serverId, {
    name: '  Updated Server  ',
    tags: ['survival', 'survival', 'economy'],
    shortDescription: '  Updated summary  ',
    longDescription: '  Updated body  ',
    websiteUrl: null,
    discordUrl: 'https://discord.gg/example',
  }, { userId: accountId, permissions: [] } as never);

  assert.deepEqual(update, {
    name: 'Updated Server',
    tags: ['survival', 'economy'],
    shortDescription: 'Updated summary',
    longDescription: 'Updated body',
    websiteUrl: null,
    discordUrl: 'https://discord.gg/example',
  });
  assert.throws(() => serverProfilePayloadSchema.parse({
    ...(update ?? {}),
    unexpected: true,
  }));
  assert.throws(() => serverProfilePayloadSchema.parse({
    ...(update ?? {}),
    longDescription: 'x'.repeat(20_001),
  }));
});
