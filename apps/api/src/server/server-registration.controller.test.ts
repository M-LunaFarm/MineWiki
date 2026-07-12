import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServerController } from './server.controller';
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
  );

  await controller.register(
    {
      name: 'Pending Server',
      joinHost: 'play.example.com',
      joinPort: 25565,
      edition: 'java',
      supportedVersions: ['1.21.1'],
      tags: ['survival'],
      shortDescription: 'Ownership verification pending',
      longDescription: 'A server waiting for DNS or MOTD ownership verification.',
      websiteUrl: null,
      discordUrl: null,
    },
    { userId: '11111111-1111-4111-8111-111111111111' } as never,
  );

  assert.equal(
    registration?.registrantAccountId,
    '11111111-1111-4111-8111-111111111111',
  );
  assert.equal('ownerAccountId' in (registration ?? {}), false);
});
