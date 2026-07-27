import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WikiNotificationService } from './wiki-notification.service';

test('support reply event queues email and in-app delivery without exposing the full reply', async () => {
  let event: {
    eventKey: string;
    payloadJson: {
      deliveries: Array<{ type: string; message: string; href: string }>;
      emailDeliveries: Array<{ to: string; text: string; messageId: string }>;
    };
  } | undefined;
  const tx = {
    account: {
      async findUnique() {
        return { email: 'customer@example.com', lifecycleStatus: 'active' };
      },
    },
    wikiProfile: {
      async findFirst(args: { where: { accountId: string } }) {
        return { id: args.where.accountId === 'customer' ? 8n : 7n };
      },
    },
    wikiNotificationEvent: {
      async createMany(args: { data: typeof event[] }) {
        [event] = args.data;
        return { count: 1 };
      },
    },
  };
  const service = new WikiNotificationService(
    {} as never,
    {} as never,
    {} as never,
  );

  await service.notifySupportTicketReply(tx as never, {
    ticketId: '11111111-1111-4111-8111-111111111111',
    messageId: '22222222-2222-4222-8222-222222222222',
    requesterAccountId: 'customer',
    guestEmail: null,
    actorAccountId: 'agent',
    subject: '로그인 문의',
    preview: '확인했습니다. 다시 로그인해 주세요.',
    repliedAt: new Date('2026-07-27T10:00:00.000Z'),
  });

  assert.equal(
    event?.eventKey,
    'support-ticket-reply:22222222-2222-4222-8222-222222222222',
  );
  assert.equal(event?.payloadJson.deliveries[0]?.type, 'support_ticket_reply');
  assert.equal(
    event?.payloadJson.deliveries[0]?.href,
    '/support?ticket=11111111-1111-4111-8111-111111111111',
  );
  assert.equal(event?.payloadJson.emailDeliveries[0]?.to, 'customer@example.com');
  assert.match(
    event?.payloadJson.emailDeliveries[0]?.messageId ?? '',
    /^<support-22222222-2222-4222-8222-222222222222@minewiki\.kr>$/,
  );
  assert.match(
    event?.payloadJson.emailDeliveries[0]?.text ?? '',
    /답변 요약: 확인했습니다\. 다시 로그인해 주세요\./u,
  );
});

test('guest support replies use the ticket email even when the synthetic account has no profile', async () => {
  let payload:
    | {
        deliveries: unknown[];
        emailDeliveries: Array<{ to: string }>;
      }
    | undefined;
  const tx = {
    account: {
      async findUnique() {
        return { email: null, lifecycleStatus: 'active' };
      },
    },
    wikiProfile: {
      async findFirst() {
        return null;
      },
    },
    wikiNotificationEvent: {
      async createMany(args: {
        data: Array<{ payloadJson: typeof payload }>;
      }) {
        payload = args.data[0]?.payloadJson;
        return { count: 1 };
      },
    },
  };
  const service = new WikiNotificationService(
    {} as never,
    {} as never,
    {} as never,
  );

  await service.notifySupportTicketReply(tx as never, {
    ticketId: '11111111-1111-4111-8111-111111111111',
    messageId: '33333333-3333-4333-8333-333333333333',
    requesterAccountId: 'guest-account',
    guestEmail: 'guest@example.com',
    actorAccountId: 'agent',
    subject: '비회원 문의',
    preview: '답변입니다.',
    repliedAt: new Date('2026-07-27T10:00:00.000Z'),
  });

  assert.deepEqual(payload?.deliveries, []);
  assert.equal(payload?.emailDeliveries[0]?.to, 'guest@example.com');
});
