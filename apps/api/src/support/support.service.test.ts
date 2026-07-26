import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  calculateSupportTicketSla,
  decodeSupportTicketCursor,
  encodeSupportTicketCursor,
  normalizeTicketListLimit,
  normalizeTicketSearch,
  SupportService,
} from './support.service';

type AccessProbe = {
  ensureTicketAccess(
    ticket: { requesterAccountId: string; assigneeAccountId: string | null },
    userId: string,
    isAgent: boolean,
  ): void;
};

type RoutingProbe = {
  resolveTicketRouting(
    serverId: string | null | undefined,
    actorAccountId?: string,
  ): Promise<{
    serverId: string | null;
    serverNameSnapshot: string | null;
  }>;
};

test('historical support assignment is not an authorization grant', () => {
  const service = new SupportService(
    {} as never,
    { isCaptchaRequired: () => false } as never,
  ) as unknown as AccessProbe;
  const ticket = {
    requesterAccountId: 'requester',
    assigneeAccountId: 'former-agent',
  };

  assert.doesNotThrow(() => service.ensureTicketAccess(ticket, 'current-agent', true));
  assert.doesNotThrow(() => service.ensureTicketAccess(ticket, 'requester', false));
  assert.throws(
    () => service.ensureTicketAccess(ticket, 'former-agent', false),
    /해당 티켓에 접근할 권한이 없습니다/,
  );
  assert.throws(
    () => service.ensureTicketAccess(ticket, 'outsider', false),
    /해당 티켓에 접근할 권한이 없습니다/,
  );
});

test('guest access codes are stored as one-way SHA-256 digests', () => {
  const accessCode = 'sample-guest-access-code-that-is-long-enough';
  const digest = createHash('sha256').update(accessCode, 'utf8').digest('hex');

  assert.equal(digest.length, 64);
  assert.notEqual(digest, accessCode);
});

test('support SLA targets are priority-aware and stop breaching after a public response', () => {
  const base = {
    createdAt: '2026-07-26T00:00:00.000Z',
    lastCustomerMessageAt: '2026-07-26T00:00:00.000Z',
    lastAgentMessageAt: null,
    resolvedAt: null,
  } as const;

  const urgent = calculateSupportTicketSla(
    { ...base, priority: 'urgent', firstResponseAt: null },
    Date.parse('2026-07-26T01:00:01.000Z'),
  );
  const responded = calculateSupportTicketSla(
    {
      ...base,
      priority: 'normal',
      firstResponseAt: '2026-07-26T00:30:00.000Z',
      lastAgentMessageAt: '2026-07-26T00:30:00.000Z',
    },
    Date.parse('2026-07-28T00:00:00.000Z'),
  );

  assert.equal(urgent.targetMinutes, 60);
  assert.equal(urgent.responseDueAt, '2026-07-26T01:00:00.000Z');
  assert.equal(urgent.breached, true);
  assert.equal(responded.targetMinutes, 1_440);
  assert.equal(responded.breached, false);
});

test('support ticket list cursors preserve stable timestamp and id boundaries', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const timestamp = '2026-07-26T12:34:56.789Z';
  const cursor = encodeSupportTicketCursor(timestamp, id);
  const decoded = decodeSupportTicketCursor(cursor);

  assert.equal(decoded?.lastMessageAt.toISOString(), timestamp);
  assert.equal(decoded?.id, id);
  assert.equal(decodeSupportTicketCursor(undefined), null);
  assert.throws(() => decodeSupportTicketCursor('not-a-cursor'), /유효하지 않은/);
  assert.throws(
    () =>
      decodeSupportTicketCursor(
        Buffer.from(
          JSON.stringify({ v: 1, lastMessageAt: timestamp, id: 'not-a-uuid' }),
        ).toString('base64url'),
      ),
    /유효하지 않은/,
  );
});

test('support ticket list query inputs are bounded for predictable service cost', () => {
  assert.equal(normalizeTicketListLimit(undefined), 50);
  assert.equal(normalizeTicketListLimit('25'), 25);
  assert.equal(normalizeTicketListLimit('1000'), 100);
  assert.throws(() => normalizeTicketListLimit('0'), /1 이상의 정수/);
  assert.throws(() => normalizeTicketListLimit('1.5'), /1 이상의 정수/);
  assert.equal(normalizeTicketSearch(`  ${'가'.repeat(100)}  `)?.length, 80);
  assert.equal(normalizeTicketSearch('   '), null);
});

test('hidden servers can only be attached by their owner, registrant, or support staff', async () => {
  const hiddenServer = {
    id: '11111111-1111-4111-8111-111111111111',
    name: '검증 중 서버',
    joinHost: 'verify.example.com',
    joinPort: 25565,
    edition: 'java',
    listingStatus: 'pending',
    ownerAccountId: 'owner',
    registrantAccountId: 'registrant',
  };
  const service = new SupportService(
    {
      server: {
        findUnique: async () => hiddenServer,
      },
      $queryRaw: async () => [],
    } as never,
    { isCaptchaRequired: () => false } as never,
    {
      hasPermission: async (accountId: string) => accountId === 'staff',
    } as never,
  ) as unknown as RoutingProbe;

  await assert.rejects(
    () => service.resolveTicketRouting(hiddenServer.id),
    /이 문의에 연결할 수 없는 서버입니다/,
  );
  await assert.rejects(
    () => service.resolveTicketRouting(hiddenServer.id, 'outsider'),
    /이 문의에 연결할 수 없는 서버입니다/,
  );
  const ownerRouting = await service.resolveTicketRouting(hiddenServer.id, 'owner');
  const staffRouting = await service.resolveTicketRouting(hiddenServer.id, 'staff');

  assert.equal(ownerRouting.serverId, hiddenServer.id);
  assert.equal(ownerRouting.serverNameSnapshot, hiddenServer.name);
  assert.equal(staffRouting.serverId, hiddenServer.id);
});
