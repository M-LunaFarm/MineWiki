import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ZodError } from 'zod';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { STEP_UP_PURPOSE_METADATA, StepUpGuard } from '../session/step-up.guard';
import { ServerWikiPublicationController } from './server-wiki-publication.controller';

const serverId = '11111111-1111-4111-8111-111111111111';
const session: SessionPayload = {
  sessionId: 'session-1',
  userId: '22222222-2222-4222-8222-222222222222',
  tokenVersion: 1,
  isElevated: true,
  authenticatedAt: '2026-07-18T00:00:00.000Z',
  permissions: ['server.admin'],
  groups: ['manager'],
};

test('publication endpoints require a session and mutations require server_admin step-up', () => {
  const controllerGuards = Reflect.getMetadata(GUARDS_METADATA, ServerWikiPublicationController) ?? [];
  assert.ok(controllerGuards.includes(SessionGuard));
  assert.equal(
    Reflect.getMetadata(STEP_UP_PURPOSE_METADATA, ServerWikiPublicationController.prototype.update),
    'server_admin',
  );
  assert.equal(Reflect.getMetadata(STEP_UP_PURPOSE_METADATA, ServerWikiPublicationController.prototype.submitCandidate), 'server_admin');
  assert.equal(Reflect.getMetadata(STEP_UP_PURPOSE_METADATA, ServerWikiPublicationController.prototype.approveCandidate), 'wiki_release_review');
  assert.equal(Reflect.getMetadata(STEP_UP_PURPOSE_METADATA, ServerWikiPublicationController.prototype.revokeCandidateApproval), 'wiki_release_review');
  assert.equal(Reflect.getMetadata(STEP_UP_PURPOSE_METADATA, ServerWikiPublicationController.prototype.requestCandidateChanges), 'wiki_release_review');
  const mutationGuards = Reflect.getMetadata(
    GUARDS_METADATA,
    ServerWikiPublicationController.prototype.update,
  ) ?? [];
  assert.ok(mutationGuards.includes(StepUpGuard));
});

test('publication endpoints have bounded operation-specific throttles', () => {
  assert.equal(
    Reflect.getMetadata('THROTTLER:LIMITdefault', ServerWikiPublicationController.prototype.get),
    30,
  );
  assert.equal(
    Reflect.getMetadata('THROTTLER:LIMITdefault', ServerWikiPublicationController.prototype.update),
    8,
  );
  assert.equal(Reflect.getMetadata('THROTTLER:LIMITdefault', ServerWikiPublicationController.prototype.submitCandidate), 8);
  assert.equal(Reflect.getMetadata('THROTTLER:LIMITdefault', ServerWikiPublicationController.prototype.approveCandidate), 12);
  assert.equal(Reflect.getMetadata('THROTTLER:LIMITdefault', ServerWikiPublicationController.prototype.revokeCandidateApproval), 12);
  assert.equal(Reflect.getMetadata('THROTTLER:LIMITdefault', ServerWikiPublicationController.prototype.requestCandidateChanges), 8);
});

test('controller trims and forwards publication mutations with canonical session identity only', async () => {
  const calls: unknown[][] = [];
  const controller = new ServerWikiPublicationController({
    async get(...args: unknown[]) {
      calls.push(['get', ...args]);
      return { status: 'draft' };
    },
    async update(...args: unknown[]) {
      calls.push(['update', ...args]);
      return { status: 'published' };
    },
    async submitCandidate(...args: unknown[]) { calls.push(['submit', ...args]); return { status: 'draft' }; },
    async approveCandidate(...args: unknown[]) { calls.push(['approve', ...args]); return { approved: true }; },
    async revokeCandidateApproval(...args: unknown[]) { calls.push(['revoke', ...args]); return { approved: false }; },
    async requestCandidateChanges(...args: unknown[]) { calls.push(['changes', ...args]); return { status: 'changes_requested' }; },
  } as never);

  await controller.get(serverId, session);
  await controller.update(serverId, {
    status: 'published',
    expectedVersion: 3,
    expectedCandidateToken: 'a'.repeat(64),
    candidateId: '17',
    reason: '  owner approved launch  ',
  }, session);
  await controller.submitCandidate(serverId, {
    expectedVersion: 3, expectedCandidateToken: 'a'.repeat(64), reason: '  request independent review  ',
  }, session);
  await controller.approveCandidate(serverId, { candidateId: '17', candidateToken: 'b'.repeat(64) }, session);
  await controller.revokeCandidateApproval(serverId, { candidateId: '17', candidateToken: 'b'.repeat(64) }, session);
  await controller.requestCandidateChanges(serverId, { candidateId: '17', candidateToken: 'b'.repeat(64), note: '  explain the required policy changes  ' }, session);

  const actor = { accountId: session.userId, permissions: ['server.admin'] };
  assert.deepEqual(calls, [
    ['get', serverId, actor],
    ['update', serverId, {
      status: 'published',
      expectedVersion: 3,
      expectedCandidateToken: 'a'.repeat(64),
      candidateId: '17',
      reason: 'owner approved launch',
    }, actor],
    ['submit', serverId, { expectedVersion: 3, expectedCandidateToken: 'a'.repeat(64), reason: 'request independent review' }, actor],
    ['approve', serverId, { candidateId: '17', candidateToken: 'b'.repeat(64) }, actor],
    ['revoke', serverId, { candidateId: '17', candidateToken: 'b'.repeat(64) }, actor],
    ['changes', serverId, { candidateId: '17', candidateToken: 'b'.repeat(64), note: 'explain the required policy changes' }, actor],
  ]);
});

test('controller rejects draft transitions, missing versions, short reasons, and unknown fields', () => {
  const controller = new ServerWikiPublicationController({} as never);
  for (const body of [
    { status: 'draft', expectedVersion: 0, reason: 'return to draft state' },
    { status: 'published', reason: 'owner approved launch' },
    { status: 'published', expectedVersion: 0, reason: 'owner approved launch' },
    { status: 'published', expectedVersion: 0, expectedCandidateToken: 'ABC', reason: 'owner approved launch' },
    { status: 'unpublished', expectedVersion: 0, reason: 'no' },
    { status: 'published', expectedVersion: 0, expectedCandidateToken: 'a'.repeat(64), reason: 'owner approved launch', force: true },
  ]) {
    assert.throws(() => controller.update(serverId, body, session), ZodError);
  }
  for (const body of [{}, { candidateId: '1', candidateToken: 'ABC' }, { candidateId: '1', candidateToken: 'a'.repeat(64), extra: true }]) {
    assert.throws(() => controller.approveCandidate(serverId, body, session), ZodError);
  }
  for (const body of [
    { candidateId: '1', candidateToken: 'a'.repeat(64), note: '' },
    { candidateId: '1', candidateToken: 'a'.repeat(64), note: '1234' },
    { candidateId: '1', candidateToken: 'a'.repeat(64), note: 'valid note', extra: true },
  ]) {
    assert.throws(() => controller.requestCandidateChanges(serverId, body, session), ZodError);
  }
});
