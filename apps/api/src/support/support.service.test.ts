import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupportService } from './support.service';

type AccessProbe = {
  ensureTicketAccess(
    ticket: { requesterAccountId: string; assigneeAccountId: string | null },
    userId: string,
    isAgent: boolean,
  ): void;
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
