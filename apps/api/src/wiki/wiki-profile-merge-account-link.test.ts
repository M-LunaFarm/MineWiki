import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WikiProfileMergeService } from './wiki-profile-merge.service';

test('account linking queues separate wiki profiles for existing administrator review', async () => {
  const sourceAccountId = randomUUID();
  const targetAccountId = randomUUID();
  const source = profile(10n, sourceAccountId, '새프로필');
  const target = profile(20n, targetAccountId, '기존프로필');
  const created: Array<{ data: Record<string, unknown> }> = [];
  const audits: Array<{ data: { action: string } }> = [];
  const zero = { async count() { return 0; } };
  const tx = {
    account: {
      async findUnique() {
        return { id: targetAccountId, canonicalAccountId: targetAccountId, lifecycleStatus: 'active' };
      },
      async findMany() {
        return [
          { id: sourceAccountId, canonicalAccountId: targetAccountId, lifecycleStatus: 'active' },
          { id: targetAccountId, canonicalAccountId: targetAccountId, lifecycleStatus: 'active' },
        ];
      },
    },
    wikiProfile: {
      async findUnique(input: { where: { id: bigint } }) {
        return input.where.id === target.id ? target : source;
      },
      async findMany(input: { where?: { id?: { not?: bigint } } }) {
        return input.where?.id?.not === target.id ? [source] : [source, target];
      },
    },
    wikiProfileMergeRequest: {
      async findMany() { return []; },
      async create(input: { data: Record<string, unknown> }) {
        created.push(input);
        return { id: randomUUID(), ...input.data };
      },
    },
    auditEvent: { async create(input: { data: { action: string } }) { audits.push(input); return {}; } },
    wikiPageRevision: zero,
    wikiRecentChange: zero,
    wikiDiscussionThread: zero,
    wikiDiscussionComment: zero,
    wikiEditRequest: zero,
    wikiPage: zero,
    wikiSpace: zero,
    wikiPageWatch: zero,
    wikiDiscussionSubscription: zero,
    wikiDiscussionPollVote: zero,
    wikiNotification: zero,
    wikiPushSubscription: zero,
    subwikiRole: zero,
    aclGroupMember: zero,
    aclRule: zero,
    wikiUserGroup: zero,
  };
  const service = new WikiProfileMergeService({} as never, {} as never);

  const ids = await service.queueForAccountLink(tx as never, {
    canonicalAccountId: targetAccountId,
    accountIds: [sourceAccountId, targetAccountId],
    preferredTargetAccountIds: [targetAccountId],
    requestedByAccountId: randomUUID(),
    reason: '계정 병합 승인 후 위키 프로필 검토',
  });

  assert.equal(ids.length, 1);
  assert.equal(created[0]?.data.sourceProfileId, 10n);
  assert.equal(created[0]?.data.targetProfileId, 20n);
  assert.equal(created[0]?.data.status, 'pending');
  assert.equal(audits[0]?.data.action, 'wiki_profile.merge_requested_after_account_link');
});

function profile(id: bigint, accountId: string, username: string) {
  return {
    id,
    accountId,
    username,
    displayName: username,
    status: 'active',
    mergedIntoProfileId: null,
    createdAt: new Date(),
  };
}
