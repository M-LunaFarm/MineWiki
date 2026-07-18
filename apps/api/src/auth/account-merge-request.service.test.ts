import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { AccountMergeRequestService } from './account-merge-request.service';
import {
  fingerprintAccountConflicts,
  type AccountLinkConflict,
} from './account-conflict.service';

function createHarness(options: {
  readonly staleConflicts?: boolean;
  readonly sourceActive?: boolean;
  readonly targetActive?: boolean;
} = {}) {
  const sourceId = randomUUID();
  const targetId = randomUUID();
  const requestId = randomUUID();
  const ticketId = randomUUID();
  const adminId = randomUUID();
  const conflict: AccountLinkConflict = {
    id: `verified-email:${targetId}`,
    kind: 'verified_email_duplicate',
    message: 'duplicate',
    minecraftUuid: null,
    discordUserId: null,
    conflictingAccountId: targetId,
    legacyWikiProfileId: null,
  };
  const deleted = {
    sessions: [] as string[][],
    passwordResets: [] as string[][],
    emailVerifications: [] as string[][],
    oauthStates: [] as string[][],
    webAuthnChallenges: [] as string[][],
    emailChanges: [] as string[][],
  };
  const audits: Array<{ data: { action: string } }> = [];
  const messages: Array<{ data: { body: string } }> = [];
  const links: Array<{ primaryAccountId: string; linkedAccountId: string }> = [];
  const accounts = [
    { id: sourceId, canonicalAccountId: sourceId, lifecycleStatus: options.sourceActive === false ? 'suspended' : 'active' },
    { id: targetId, canonicalAccountId: targetId, lifecycleStatus: options.targetActive === false ? 'deletion_pending' : 'active' },
  ];
  let request = {
    id: requestId,
    ticketId,
    requesterAccountId: sourceId,
    sourceCanonicalAccountId: sourceId,
    targetCanonicalAccountId: targetId,
    candidateTargetAccountIds: [targetId],
    conflictSnapshot: [conflict],
    conflictFingerprint: fingerprintAccountConflicts([conflict]),
    proofSummary: null,
    status: 'pending',
    activeKey: sourceId,
    version: 1,
    decidedByAccountId: null,
    decisionReason: null,
    decidedAt: null,
    createdAt: new Date('2026-07-18T00:00:00Z'),
    updatedAt: new Date('2026-07-18T00:00:00Z'),
  };

  const prisma = {
    accountMergeRequest: {
      async findUnique() { return request; },
      async findMany() { return [request]; },
      async update(input: { data: Record<string, unknown> }) {
        const data = { ...input.data } as Record<string, unknown>;
        const version = data.version as { increment?: number } | number | undefined;
        request = {
          ...request,
          ...data,
          version: typeof version === 'object' ? request.version + (version.increment ?? 0) : version ?? request.version,
          updatedAt: new Date(),
        } as typeof request;
        return request;
      },
    },
    account: {
      async findUnique(input: { where: { id: string } }) {
        return accounts.find((account) => account.id === input.where.id) ?? null;
      },
      async findMany(input: { where?: { OR?: Array<{ id?: { in?: string[] }; canonicalAccountId?: { in?: string[] } }> } }) {
        const frontier = input.where?.OR?.flatMap((part) =>
          part.id?.in ?? part.canonicalAccountId?.in ?? [],
        ) ?? accounts.map((account) => account.id);
        return accounts.filter((account) =>
          frontier.includes(account.id) || frontier.includes(account.canonicalAccountId),
        );
      },
      async count(input: { where: { id: { in: string[] }; lifecycleStatus: string } }) {
        return accounts.filter((account) =>
          input.where.id.in.includes(account.id) && account.lifecycleStatus === input.where.lifecycleStatus,
        ).length;
      },
    },
    accountLink: {
      async findMany() { return links; },
    },
    session: deletionStore(deleted.sessions, 'accountId'),
    passwordReset: deletionStore(deleted.passwordResets, 'accountId'),
    emailVerification: deletionStore(deleted.emailVerifications, 'accountId'),
    oAuthState: deletionStore(deleted.oauthStates, 'linkAccountId'),
    webAuthnChallenge: deletionStore(deleted.webAuthnChallenges, 'accountId'),
    accountEmailChange: {
      async updateMany(input: { where: { canonicalAccountId: { in: string[] } } }) {
        deleted.emailChanges.push(input.where.canonicalAccountId.in);
        return { count: 1 };
      },
    },
    supportTicket: { async update() { return {}; } },
    supportMessage: { async create(input: { data: { body: string } }) { messages.push(input); return {}; } },
    auditEvent: { async create(input: { data: { action: string } }) { audits.push(input); return {}; } },
    async $queryRaw() { return accounts.map((account) => ({ id: account.id })); },
    async $transaction<T>(operation: (tx: typeof prisma) => Promise<T>) { return operation(prisma); },
  };
  const conflictService = {
    async listLinkConflicts() {
      return { conflicts: options.staleConflicts ? [] : [conflict] };
    },
  };
  const accountService = {
    async linkActiveAccountsInTransaction(
      _tx: unknown,
      primaryAccountId: string,
      linkedAccountId: string,
      accountIds: string[],
    ) {
      links.push({ primaryAccountId, linkedAccountId });
      assert.deepEqual(accountIds, [sourceId, targetId].sort());
      return targetId;
    },
  };
  const wikiProfileMerges = {
    async queueForAccountLink() { return []; },
  };
  return {
    sourceId,
    targetId,
    requestId,
    ticketId,
    adminId,
    deleted,
    audits,
    messages,
    links,
    get request() { return request; },
    service: new AccountMergeRequestService(
      prisma as never,
      conflictService as never,
      accountService as never,
      wikiProfileMerges as never,
    ),
  };
}

test('approval links the locked groups and revokes every existing authentication state', async () => {
  const harness = createHarness();
  const result = await harness.service.approve(harness.requestId, harness.adminId, {
    targetCanonicalAccountId: harness.targetId,
    reason: '두 로그인 수단의 소유권 증거를 확인했습니다.',
    evidenceConfirmed: true,
    version: 1,
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(harness.links, [{
    primaryAccountId: harness.targetId,
    linkedAccountId: harness.sourceId,
  }]);
  for (const values of Object.values(harness.deleted)) {
    assert.deepEqual(values, [[harness.sourceId, harness.targetId].sort()]);
  }
  assert.equal(harness.audits.at(-1)?.data.action, 'account.merge_request.approved');
  assert.match(harness.messages.at(-1)?.data.body ?? '', /기존 세션이 모두 종료/u);
});

test('stale conflict evidence fails closed before any account graph mutation', async () => {
  const harness = createHarness({ staleConflicts: true });
  await assert.rejects(
    harness.service.approve(harness.requestId, harness.adminId, {
      targetCanonicalAccountId: harness.targetId,
      reason: '충분한 외부 소유권 증거를 확인했습니다.',
      evidenceConfirmed: true,
      version: 1,
    }),
    (error: unknown) => error instanceof ConflictException,
  );
  assert.deepEqual(harness.links, []);
  assert.equal(harness.request.status, 'pending');
});

test('inactive accounts cannot be approved', async () => {
  const harness = createHarness({ targetActive: false });
  await assert.rejects(
    harness.service.approve(harness.requestId, harness.adminId, {
      targetCanonicalAccountId: harness.targetId,
      reason: '충분한 외부 소유권 증거를 확인했습니다.',
      evidenceConfirmed: true,
      version: 1,
    }),
    (error: unknown) => error instanceof ConflictException,
  );
  assert.deepEqual(harness.links, []);
});

test('optimistic request versions prevent stale or duplicate administrator decisions', async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.service.approve(harness.requestId, harness.adminId, {
      targetCanonicalAccountId: harness.targetId,
      reason: '충분한 외부 소유권 증거를 확인했습니다.',
      evidenceConfirmed: true,
      version: 2,
    }),
    (error: unknown) => error instanceof ConflictException,
  );
  assert.deepEqual(harness.links, []);
});

test('rejection records the reason without changing the account graph', async () => {
  const harness = createHarness();
  const result = await harness.service.reject(harness.requestId, harness.adminId, {
    reason: '상대 계정 소유권 증거가 충분하지 않습니다.',
    version: 1,
  });
  assert.equal(result.status, 'rejected');
  assert.deepEqual(harness.links, []);
  assert.equal(harness.audits.at(-1)?.data.action, 'account.merge_request.rejected');
  assert.match(harness.messages.at(-1)?.data.body ?? '', /증거가 충분하지/u);
});

function deletionStore(target: string[][], field: 'accountId' | 'linkAccountId') {
  return {
    async deleteMany(input: { where: Record<string, { in: string[] }> }) {
      target.push(input.where[field]!.in);
      return { count: 1 };
    },
  };
}
