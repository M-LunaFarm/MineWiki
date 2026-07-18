import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { SupportController } from '../support/support.controller';
import { WikiAdminController } from '../wiki/wiki-admin.controller';
import { SessionController } from '../session/session.controller';
import { RoleAdminController } from '../roles/role-admin.controller';
import { ClaimController } from '../claim/claim.controller';
import { PluginClaimController } from '../claim/plugin-claim.controller';
import { VoteDiagnosticsController } from '../vote/vote-diagnostics.controller';
import { ServerVerificationController } from '../server/server-verification.controller';
import { ReviewController } from '../review/review.controller';
import { ReviewModerationController } from '../review/review-moderation.controller';
import { WikiReportController } from '../wiki/wiki-report.controller';
import { WikiReportModerationController } from '../wiki/wiki-report-moderation.controller';
import { AccountEmailChangeController } from '../auth/account-email-change.controller';

const THROTTLER_LIMIT = 'THROTTLER:LIMITdefault';
const THROTTLER_TTL = 'THROTTLER:TTLdefault';

const protectedHandlers = [
  [SupportController, 'createTicket'],
  [SupportController, 'createGuestTicket'],
  [SupportController, 'createMessage'],
  [SupportController, 'updateTicket'],
  [WikiAdminController, 'updateProtection'],
  [WikiAdminController, 'updateRevisionVisibility'],
  [WikiAdminController, 'rollback'],
  [WikiAdminController, 'deletePage'],
  [WikiAdminController, 'restorePage'],
  [SessionController, 'revokeOtherSessions'],
  [SessionController, 'revokeSession'],
  [RoleAdminController, 'assignRole'],
  [RoleAdminController, 'removeRole'],
  [ClaimController, 'start'],
  [ClaimController, 'verify'],
  [PluginClaimController, 'complete'],
  [VoteDiagnosticsController, 'runDiagnostics'],
  [ServerVerificationController, 'recheck'],
  [ReviewController, 'reply'],
  [ReviewModerationController, 'assign'],
  [ReviewModerationController, 'resolve'],
  [ReviewModerationController, 'dismiss'],
  [WikiReportController, 'report'],
  [WikiReportModerationController, 'assign'],
  [WikiReportModerationController, 'transition'],
  [AccountEmailChangeController, 'request'],
  [AccountEmailChangeController, 'resend'],
  [AccountEmailChangeController, 'confirm'],
] as const;

test('high-risk mutation endpoints define explicit rate limits', () => {
  for (const [controller, method] of protectedHandlers) {
    const handler = controller.prototype[method] as (...args: never[]) => unknown;
    const limit = Reflect.getMetadata(THROTTLER_LIMIT, handler) as number | undefined;
    const ttl = Reflect.getMetadata(THROTTLER_TTL, handler) as number | undefined;

    assert.ok(limit && limit > 0, `${controller.name}.${method} is missing a rate limit`);
    assert.ok(ttl && ttl >= 60, `${controller.name}.${method} is missing a rate-limit window`);
  }
});
