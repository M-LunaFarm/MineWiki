import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AccountDeletionAdminController } from '../auth/account-deletion-admin.controller';
import { AccountModerationController } from '../auth/account-moderation.controller';
import { AuditController } from '../events/audit.controller';
import { ReviewModerationController } from '../review/review-moderation.controller';
import { RoleAdminController } from '../roles/role-admin.controller';
import { ServerController } from '../server/server.controller';
import { ServerWikiLayoutEntitlementAdminController } from '../server/server-wiki-layout-entitlement-admin.controller';
import { SessionGuard } from '../session/session.guard';
import { STEP_UP_PURPOSE_METADATA, StepUpGuard } from '../session/step-up.guard';
import { VoteAdminController } from '../vote/vote-admin.controller';
import { VoteDiagnosticsController } from '../vote/vote-diagnostics.controller';
import { VoteDispatchController } from '../vote/vote-dispatch.controller';
import { VoteMonitorController } from '../vote/vote-monitor.controller';
import { WikiAclGroupAdminController } from '../wiki/wiki-acl-group.controller';
import { WikiAdminController } from '../wiki/wiki-admin.controller';
import { WikiPageAclController } from '../wiki/wiki-page-acl.controller';
import { WikiReportModerationController } from '../wiki/wiki-report-moderation.controller';

const classPolicies = [
  [WikiAdminController, 'wiki_admin'],
  [WikiAclGroupAdminController, 'wiki_admin'],
  [RoleAdminController, 'role_admin'],
  [AuditController, 'audit_read'],
  [AccountDeletionAdminController, 'account_delete_admin'],
  [AccountModerationController, 'account_moderation'],
  [ReviewModerationController, 'review_moderation'],
  [WikiReportModerationController, 'wiki_admin'],
  [VoteAdminController, 'vote_admin'],
  [VoteMonitorController, 'vote_admin'],
  [ServerWikiLayoutEntitlementAdminController, 'server_admin'],
] as const;

const methodPolicies = [
  [WikiPageAclController, 'createRule', 'wiki_admin'],
  [WikiPageAclController, 'deleteRule', 'wiki_admin'],
  [WikiPageAclController, 'reorderRules', 'wiki_admin'],
  [VoteDispatchController, 'list', 'server_admin'],
  [VoteDispatchController, 'replay', 'server_admin'],
  [VoteDiagnosticsController, 'runDiagnostics', 'server_admin'],
  [ServerController, 'updateWikiLayout', 'server_admin'],
  [ServerController, 'listPluginCredentials', 'server_admin'],
  [ServerController, 'listPluginCredentialEvents', 'server_admin'],
  [ServerController, 'createPluginCredential', 'server_admin'],
  [ServerController, 'rotatePluginCredential', 'server_admin'],
  [ServerController, 'updatePluginCredential', 'server_admin'],
  [ServerController, 'createServerWiki', 'server_admin'],
  [ServerController, 'linkServerWiki', 'server_admin'],
  [ServerController, 'remove', 'server_admin'],
  [ServerController, 'updateVotePolicy', 'server_admin'],
  [ServerController, 'votifierTargets', 'server_admin'],
  [ServerController, 'updateVotifierTargets', 'server_admin'],
] as const;

test('high-risk controller classes require their purpose-bound MFA policy', () => {
  for (const [controller, purpose] of classPolicies) {
    assert.equal(Reflect.getMetadata(STEP_UP_PURPOSE_METADATA, controller), purpose);
    assertGuardOrder(controller, controller.name);
  }
});

test('high-risk controller methods require their purpose-bound MFA policy', () => {
  for (const [controller, methodName, purpose] of methodPolicies) {
    const handler = controller.prototype[methodName];
    assert.equal(
      Reflect.getMetadata(STEP_UP_PURPOSE_METADATA, handler),
      purpose,
      `${controller.name}.${methodName} must require ${purpose}`,
    );
    assertGuardOrder(handler, `${controller.name}.${methodName}`);
  }
});

function guardsOf(target: object): unknown[] {
  return Reflect.getMetadata(GUARDS_METADATA, target) ?? [];
}

function assertGuardOrder(target: object, label: string): void {
  const guards = guardsOf(target);
  const sessionIndex = guards.indexOf(SessionGuard);
  const stepUpIndex = guards.indexOf(StepUpGuard);
  assert.ok(sessionIndex >= 0, `${label} must use SessionGuard`);
  assert.ok(stepUpIndex > sessionIndex, `${label} must run StepUpGuard after SessionGuard`);
}
