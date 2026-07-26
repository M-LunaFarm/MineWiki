import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGuestSupportTicketSchema,
  createSupportTicketSchema,
  guestSupportAccessSchema,
  guestSupportRecoverySchema,
  supportServerOptionsResponseSchema,
  supportTicketSchema,
} from '@minewiki/schemas';

test('support ticket schemas accept operational context fields', () => {
  const createPayload = createSupportTicketSchema.parse({
    subject: '플러그인 동기화가 실패합니다',
    body: '최근 투표 전달 후 동기화 상태가 멈췄습니다.',
    category: 'plugin_sync',
    priority: 'high',
    serverId: '11111111-1111-4111-8111-111111111111',
    pageId: '42',
    verifySessionId: 'verify-session-1',
    pluginServerId: 'plugin-server-1',
    fileId: 'file-1',
  });

  assert.equal(createPayload.category, 'plugin_sync');
  assert.equal(createPayload.pluginServerId, 'plugin-server-1');

  const ticket = supportTicketSchema.parse({
    id: '22222222-2222-4222-8222-222222222222',
    subject: createPayload.subject,
    status: 'open',
    priority: createPayload.priority,
    category: createPayload.category,
    pageId: createPayload.pageId,
    verifySessionId: createPayload.verifySessionId,
    pluginServerId: createPayload.pluginServerId,
    fileId: createPayload.fileId,
    lastMessageAt: '2026-07-06T00:00:00.000Z',
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    requester: {
      id: '33333333-3333-4333-8333-333333333333',
      displayName: 'Requester',
    },
    assignee: null,
    contactEmail: null,
    server: {
      id: createPayload.serverId,
      name: 'Test Server',
      joinHost: 'play.example.com',
      joinPort: 25565,
      edition: 'java',
      listingStatus: 'active',
    },
    latestMessagePreview: null,
    messageCount: 1,
  });

  assert.equal(ticket.pageId, '42');
  assert.equal(ticket.verifySessionId, 'verify-session-1');
  assert.equal(ticket.pluginServerId, 'plugin-server-1');
  assert.equal(ticket.fileId, 'file-1');
});

test('support server options expose lifecycle and relationship metadata', () => {
  const response = supportServerOptionsResponseSchema.parse({
    items: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: '검증 중 서버',
        joinHost: 'verify.example.com',
        joinPort: 25565,
        edition: 'java',
        listingStatus: 'pending',
        relationship: 'registrant',
      },
    ],
  });

  assert.equal(response.items[0]?.listingStatus, 'pending');
  assert.equal(response.items[0]?.relationship, 'registrant');
  assert.throws(() =>
    supportServerOptionsResponseSchema.parse({
      items: [
        {
          ...response.items[0],
          listingStatus: 'deleted',
        },
      ],
    }),
  );
});

test('guest support schemas require bounded credentials and recovery identity', () => {
  const createPayload = createGuestSupportTicketSchema.parse({
    subject: '로그인 없이 문의합니다',
    body: '답변을 확인할 수 있어야 합니다.',
    guestName: 'Guest',
    guestEmail: 'guest@example.com',
  });
  const access = guestSupportAccessSchema.parse({
    ticketId: '22222222-2222-4222-8222-222222222222',
    accessCode: 'a'.repeat(43),
  });
  const recovery = guestSupportRecoverySchema.parse({
    ticketId: access.ticketId,
    email: createPayload.guestEmail,
    captchaToken: 'verified-token',
  });

  assert.equal(createPayload.guestEmail, 'guest@example.com');
  assert.equal(access.accessCode.length, 43);
  assert.equal(recovery.captchaToken, 'verified-token');
  assert.throws(() =>
    guestSupportAccessSchema.parse({
      ticketId: access.ticketId,
      accessCode: 'too-short',
    }),
  );
});
