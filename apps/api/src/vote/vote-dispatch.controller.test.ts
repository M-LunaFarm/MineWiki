import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoteDispatchController } from './vote-dispatch.controller';
import type { SessionPayload } from '../session/session.service';

const elevatedUser: SessionPayload = {
  sessionId: 'session-1',
  userId: 'account-1',
  isElevated: true,
  groups: [],
  permissions: []
};

test('vote dispatch diagnostics reject elevation without server authority', async () => {
  let queried = false;
  const controller = new VoteDispatchController({
    async listDispatchAttempts() { queried = true; return []; }
  } as never, {
    async isOwner() { return false; }
  } as never);

  await assert.rejects(
    () => controller.list('server-1', elevatedUser),
    /투표 전달 기록을 볼 권한이 없습니다/
  );
  assert.equal(queried, false);
});

test('vote dispatch diagnostics accept explicit server administration', async () => {
  const controller = new VoteDispatchController({
    async listDispatchAttempts() { return [{ id: 'attempt-1' }]; }
  } as never, {
    async isOwner() { return false; }
  } as never);

  const result = await controller.list('server-1', {
    ...elevatedUser,
    isElevated: false,
    permissions: ['server.admin']
  });
  assert.deepEqual(result, [{ id: 'attempt-1' }]);
});
