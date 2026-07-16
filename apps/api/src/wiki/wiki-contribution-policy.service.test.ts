import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { WikiContributionPolicyService } from './wiki-contribution-policy.service';

test('server wiki contribution policy requires the exact current version', async () => {
  const service = policyService({
    contributionPolicySource: '기여 정책',
    requireContributionPolicyAck: true,
    contributionPolicyVersion: 4,
  });

  await assert.rejects(
    () => service.assertAccepted(7n),
    hasCode('WIKI_CONTRIBUTION_POLICY_ACCEPTANCE_REQUIRED', 422),
  );
  await assert.rejects(
    () => service.assertAccepted(7n, { accepted: true, version: 3 }),
    hasCode('WIKI_CONTRIBUTION_POLICY_CHANGED', 409),
  );
  assert.equal(
    await service.assertAccepted(7n, { accepted: true, version: 4 }),
    4,
  );
});

test('approval rejects requests accepted against an older policy version', async () => {
  const service = policyService({
    contributionPolicySource: '새 정책',
    requireContributionPolicyAck: true,
    contributionPolicyVersion: 9,
  });

  await assert.rejects(
    () => service.assertStoredVersionCurrent(7n, 8),
    hasCode('WIKI_CONTRIBUTION_POLICY_CHANGED', 409),
  );
  await service.assertStoredVersionCurrent(7n, 9);
});

test('ordinary wiki spaces and optional policies preserve existing edit behavior', async () => {
  const noServerWiki = new WikiContributionPolicyService({
    serverWiki: { async findFirst() { return null; } },
  } as never);
  assert.equal(await noServerWiki.assertAccepted(1n), null);

  const optionalPolicy = policyService({
    contributionPolicySource: '안내만 제공',
    requireContributionPolicyAck: false,
    contributionPolicyVersion: 2,
  });
  assert.equal(await optionalPolicy.assertAccepted(2n), null);
});

function policyService(row: {
  contributionPolicySource: string | null;
  requireContributionPolicyAck: boolean;
  contributionPolicyVersion: number;
}) {
  return new WikiContributionPolicyService({
    serverWiki: { async findFirst() { return row; } },
  } as never);
}

function hasCode(code: string, status: number) {
  return (error: unknown): boolean => {
    if (!(error instanceof HttpException) || error.getStatus() !== status) return false;
    const response = error.getResponse();
    return typeof response === 'object' && response !== null && 'code' in response
      && response.code === code;
  };
}
