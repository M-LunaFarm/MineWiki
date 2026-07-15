import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { ConfigService } from '@minewiki/config';
import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';
import { WikiDiscussionLiveService } from './wiki-discussion-live.service';

const page = {
  id: 10n, namespaceId: 1, spaceId: 2n, localPath: 'guide', slug: 'guide', title: 'Guide', displayTitle: 'Guide',
  currentRevisionId: 1n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 20n,
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z')
};
const thread = {
  id: 30n, pageId: page.id, title: 'secret title never transported', status: 'open', createdBy: 20n,
  pinnedCommentId: null, createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z')
};
const session = { userId: 'account-1' } as SessionPayload;

function createLive(options: { deny?: boolean; missing?: boolean } = {}) {
  let readChecks = 0;
  let denied = options.deny ?? false;
  const prisma = {
    wikiDiscussionThread: { async findUnique() { return options.missing ? null : thread; } },
    wikiPage: { async findUnique() { return page; } }
  } as unknown as PrismaService;
  const profiles = {
    async ensureWikiProfile() { return { id: 20n, status: 'active' }; }
  } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: session.userId, profileId: 20n, status: 'active' }; },
    async assertCanReadThread() {
      readChecks += 1;
      if (denied) throw new NotFoundException('Wiki discussion thread not found.');
    }
  } as unknown as WikiPermissionService;
  const config = { getOptional() { return undefined; } } as unknown as ConfigService;
  return {
    live: new WikiDiscussionLiveService(prisma, profiles, permissions, config),
    readChecks: () => readChecks,
    setDenied(value: boolean) { denied = value; }
  };
}

test('SSE stream checks thread ACL before returning and missing or denied threads stay 404', async () => {
  const denied = createLive({ deny: true });
  await assert.rejects(denied.live.openEvents('30', session), NotFoundException);
  assert.equal(denied.readChecks(), 1);

  const missing = createLive({ missing: true });
  await assert.rejects(missing.live.openEvents('30', null), NotFoundException);
  assert.equal(missing.readChecks(), 0);

  const outOfRange = createLive();
  await assert.rejects(outOfRange.live.openEvents('18446744073709551616', null), NotFoundException);
  assert.equal(outOfRange.readChecks(), 0);
});

test('local fallback and any Last-Event-ID produce a content-free initial sync before invalidations', async () => {
  const { live } = createLive();
  const stream = await live.openEvents('30', session, 'stale-event-id');
  const events: Array<{ type?: string; id?: string; data: unknown }> = [];
  const subscription = stream.subscribe((event) => events.push(event));

  live.publish(30n);

  assert.deepEqual(events.map(({ type, data }) => ({ type, data })), [
    { type: 'sync', data: {} },
    { type: 'invalidate', data: {} }
  ]);
  assert.match(events[0]?.id ?? '', /^[0-9a-f-]{36}$/i);
  assert.match(events[1]?.id ?? '', /^[0-9a-f-]{36}$/i);
  assert.equal(JSON.stringify(events).includes(thread.title), false);
  assert.equal(JSON.stringify(events).includes(session.userId), false);

  subscription.unsubscribe();
  await live.onModuleDestroy();
});

test('ACL is rechecked every 10 seconds and a periodic sync catches lost Pub/Sub invalidations', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const { live, readChecks } = createLive();
  const stream = await live.openEvents('30');
  const eventTypes: string[] = [];
  const subscription = stream.subscribe((event) => eventTypes.push(event.type ?? ''));

  for (let index = 0; index < 3; index += 1) {
    context.mock.timers.tick(10_000);
    for (let flush = 0; flush < 10; flush += 1) await Promise.resolve();
  }

  assert.equal(readChecks(), 4);
  assert.deepEqual(eventTypes, ['sync', 'heartbeat', 'heartbeat', 'heartbeat', 'sync']);
  subscription.unsubscribe();
  await live.onModuleDestroy();
});

test('an ACL revocation completes an existing stream without emitting protected content', async (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const state = createLive();
  const stream = await state.live.openEvents('30', session);
  const eventTypes: string[] = [];
  let completed = false;
  const subscription = stream.subscribe({
    next: (event) => eventTypes.push(event.type ?? ''),
    complete: () => { completed = true; }
  });

  state.setDenied(true);
  context.mock.timers.tick(10_000);
  for (let flush = 0; flush < 10; flush += 1) await Promise.resolve();

  assert.equal(completed, true);
  assert.deepEqual(eventTypes, ['sync']);
  subscription.unsubscribe();
  await state.live.onModuleDestroy();
});

test('Redis transport input is validated and remote invalidations use the same empty SSE payload', async () => {
  const { live } = createLive();
  const stream = await live.openEvents('30');
  const eventTypes: string[] = [];
  const subscription = stream.subscribe((event) => eventTypes.push(event.type ?? ''));

  live.acceptTransportMessage('{"v":1,"source":"remote","eventId":"bad","threadId":"30","content":"leak"}');
  live.acceptTransportMessage(JSON.stringify({
    v: 1,
    source: 'remote-instance',
    eventId: '5a0335ae-6e1a-4382-bfaa-aeef58bbd39d',
    threadId: '30'
  }));

  assert.deepEqual(eventTypes, ['sync', 'invalidate']);
  subscription.unsubscribe();
  await live.onModuleDestroy();
});

test('every discussion and thread ACL mutation that changes visible state publishes an invalidation', async () => {
  const [discussionSource, aclSource] = await Promise.all([
    readFile(new URL('./wiki-discussion.service.ts', import.meta.url), 'utf8'),
    readFile(new URL('./wiki-thread-acl.service.ts', import.meta.url), 'utf8')
  ]);
  for (const method of [
    'createThread', 'addComment', 'votePoll', 'closePoll', 'setThreadStatus', 'updateThreadTopic',
    'moveThread', 'deleteThread', 'setPinnedComment', 'deleteComment', 'setCommentVisibility'
  ]) {
    assert.match(methodSource(discussionSource, method), /\n\x20{4}this\.live\?\.publish\(thread\.id\);/,
      `${method} must publish after its database operation returns`);
  }
  for (const method of ['createRule', 'deleteRule', 'reorderRules']) {
    assert.match(methodSource(aclSource, method), /\n\x20{4}this\.live\?\.publish\(thread\.id\);/,
      `${method} must publish after its transaction returns`);
  }
});

function methodSource(source: string, method: string): string {
  const start = source.indexOf(`  async ${method}(`);
  assert.notEqual(start, -1, `missing method ${method}`);
  const nextPublic = source.indexOf('\n  async ', start + 1);
  const nextPrivate = source.indexOf('\n  private ', start + 1);
  const candidates = [nextPublic, nextPrivate].filter((index) => index >= 0);
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}
