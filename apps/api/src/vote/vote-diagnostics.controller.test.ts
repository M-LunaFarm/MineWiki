import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { VoteDiagnosticsController } from './vote-diagnostics.controller';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';

const session = (permissions: string[] = []): SessionPayload => ({
  sessionId: 'session-1',
  userId: 'account-1',
  isElevated: false,
  permissions
});

test('Votifier diagnostics require an authenticated session', () => {
  const guards = Reflect.getMetadata(
    GUARDS_METADATA,
    VoteDiagnosticsController.prototype.runDiagnostics
  ) as unknown[] | undefined;
  assert.ok(Array.isArray(guards));
  assert.ok(guards.includes(SessionGuard));
});

test('Votifier diagnostics reject non-owners before opening a connection', async () => {
  let diagnosticsCalled = false;
  const controller = new VoteDiagnosticsController(
    {
      async runDiagnostics() {
        diagnosticsCalled = true;
        return {};
      }
    } as never,
    { async isOwner() { return false; } } as never
  );

  await assert.rejects(
    () => controller.runDiagnostics('11111111-1111-4111-8111-111111111111', {}, session()),
    /Votifier 진단을 실행할 권한이 없습니다/
  );
  assert.equal(diagnosticsCalled, false);
});

test('server administrators may run Votifier diagnostics', async () => {
  let diagnosticsCalled = false;
  const controller = new VoteDiagnosticsController(
    {
      async runDiagnostics(serverId: string) {
        diagnosticsCalled = true;
        return { serverId };
      }
    } as never,
    { async isOwner() { return false; } } as never
  );

  const result = await controller.runDiagnostics(
    '11111111-1111-4111-8111-111111111111',
    {},
    session(['server.admin'])
  );
  assert.equal(diagnosticsCalled, true);
  assert.equal(result.serverId, '11111111-1111-4111-8111-111111111111');
});
