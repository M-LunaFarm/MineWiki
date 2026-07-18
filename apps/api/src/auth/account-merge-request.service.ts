import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { writeAuditRecord } from '../events/audit-event-writer';
import {
  type CanonicalAccountGroup,
  readCanonicalAccountGroup,
  withCanonicalAccountGroups,
} from './account-lifecycle-fence';
import {
  AccountConflictService,
  fingerprintAccountConflicts,
  type AccountLinkConflict,
} from './account-conflict.service';
import { AccountSeparationService } from './account-separation.service';
import { WikiProfileMergeService } from '../wiki/wiki-profile-merge.service';

const decisionSchema = z.object({
  targetCanonicalAccountId: z.string().uuid(),
  reason: z.string().trim().min(8).max(1000),
  evidenceConfirmed: z.literal(true),
  version: z.number().int().positive(),
});

const rejectionSchema = z.object({
  reason: z.string().trim().min(8).max(1000),
  version: z.number().int().positive(),
});

const STATUSES = new Set(['pending', 'completed', 'rejected', 'failed']);

@Injectable()
export class AccountMergeRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conflicts: AccountConflictService,
    private readonly accounts: AccountSeparationService,
    private readonly wikiProfileMerges: WikiProfileMergeService,
  ) {}

  async list(status?: string) {
    const normalized = status?.trim().toLowerCase();
    if (normalized && !STATUSES.has(normalized)) {
      throw new BadRequestException('지원하지 않는 계정 병합 요청 상태입니다.');
    }
    const rows = await this.prisma.accountMergeRequest.findMany({
      where: normalized ? { status: normalized } : undefined,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return rows.map(serializeRequest);
  }

  async approve(requestId: string, adminAccountId: string, body: unknown) {
    const input = decisionSchema.parse(body);
    const current = await this.prisma.accountMergeRequest.findUnique({ where: { id: requestId } });
    if (!current) throw new NotFoundException('계정 병합 요청을 찾을 수 없습니다.');
    if (current.status === 'completed') return serializeRequest(current);
    if (current.status !== 'pending') throw new ConflictException('대기 중인 병합 요청만 승인할 수 있습니다.');
    if (current.version !== input.version) throw new ConflictException('계정 병합 요청이 다른 관리자에 의해 변경되었습니다.');

    const candidates = jsonStringArray(current.candidateTargetAccountIds);
    if (!candidates.includes(input.targetCanonicalAccountId)) {
      throw new BadRequestException('승인 대상 계정은 요청 당시 감지된 충돌 계정과 일치해야 합니다.');
    }
    if (
      current.targetCanonicalAccountId &&
      current.targetCanonicalAccountId !== input.targetCanonicalAccountId
    ) {
      throw new BadRequestException('승인 대상 대표 계정 확인 값이 요청과 일치하지 않습니다.');
    }

    const freshConflicts = (await this.conflicts.listLinkConflicts(
      current.sourceCanonicalAccountId,
    )).conflicts;
    if (fingerprintAccountConflicts(freshConflicts) !== current.conflictFingerprint) {
      throw new ConflictException('요청 이후 계정 충돌 증거가 변경되어 다시 접수해야 합니다.');
    }
    assertSnapshotTargets(current.conflictSnapshot, candidates);
    const targetGroup = await readCanonicalAccountGroup(
      this.prisma,
      input.targetCanonicalAccountId,
    );
    if (targetGroup.canonicalAccountId !== input.targetCanonicalAccountId) {
      throw new ConflictException('승인 대상 대표 계정이 요청 이후 변경되었습니다.');
    }

    return withCanonicalAccountGroups(
      this.prisma,
      [current.sourceCanonicalAccountId, input.targetCanonicalAccountId],
      async (tx, groups) => {
        await tx.$queryRaw`SELECT id FROM account_merge_requests WHERE id = ${requestId} FOR UPDATE`;
        const request = await tx.accountMergeRequest.findUnique({ where: { id: requestId } });
        if (!request) throw new NotFoundException('계정 병합 요청을 찾을 수 없습니다.');
        if (request.status === 'completed') return serializeRequest(request);
        if (request.status !== 'pending' || request.version !== input.version) {
          throw new ConflictException('다른 관리자가 계정 병합 요청을 먼저 처리했습니다.');
        }

        const sourceGroup = requireGroup(groups, current.sourceCanonicalAccountId);
        const lockedTargetGroup = requireGroup(groups, input.targetCanonicalAccountId);
        if (
          sourceGroup.canonicalAccountId !== request.sourceCanonicalAccountId ||
          lockedTargetGroup.canonicalAccountId !== input.targetCanonicalAccountId
        ) {
          throw new ConflictException('계정 대표 관계가 요청 이후 변경되었습니다.');
        }
        if (sameIds(sourceGroup.accountIds, lockedTargetGroup.accountIds)) {
          throw new ConflictException('두 계정은 이미 같은 계정 그룹에 연결되어 있습니다.');
        }

        const accountIds = [...new Set([
          ...sourceGroup.accountIds,
          ...lockedTargetGroup.accountIds,
        ])].sort();
        const active = await tx.account.count({
          where: { id: { in: accountIds }, lifecycleStatus: 'active' },
        });
        if (active !== accountIds.length) {
          throw new ConflictException('종료 또는 정지 상태인 계정은 병합할 수 없습니다.');
        }

        const canonicalAccountId = await this.accounts.linkActiveAccountsInTransaction(
          tx,
          lockedTargetGroup.canonicalAccountId,
          sourceGroup.canonicalAccountId,
          accountIds,
        );
        const wikiProfileMergeRequestIds = await this.wikiProfileMerges.queueForAccountLink(tx, {
          canonicalAccountId,
          accountIds,
          preferredTargetAccountIds: lockedTargetGroup.accountIds,
          requestedByAccountId: adminAccountId,
          reason: `계정 병합 요청 ${request.id} 승인에 따른 위키 프로필 검토`,
        });
        await revokeAuthenticationState(tx, accountIds);
        const now = new Date();
        const updated = await tx.accountMergeRequest.update({
          where: { id: request.id },
          data: {
            targetCanonicalAccountId: canonicalAccountId,
            status: 'completed',
            activeKey: null,
            version: { increment: 1 },
            decidedByAccountId: adminAccountId,
            decisionReason: input.reason,
            decidedAt: now,
            proofSummary: {
              evidenceConfirmed: true,
              conflictFingerprint: request.conflictFingerprint,
              sourceAccountIds: sourceGroup.accountIds,
              targetAccountIds: lockedTargetGroup.accountIds,
              canonicalAccountId,
              wikiProfileMergeRequestIds,
              decidedAt: now.toISOString(),
            },
          },
        });
        await tx.supportTicket.update({
          where: { id: request.ticketId },
          data: { status: 'resolved', updatedAt: now, lastMessageAt: now },
        });
        await tx.supportMessage.create({
          data: {
            id: randomUUID(),
            ticketId: request.ticketId,
            authorAccountId: adminAccountId,
            authorRole: 'system',
            body: '신원 및 로그인 수단 소유권 확인이 완료되어 계정 연결이 승인되었습니다. 보안을 위해 기존 세션이 모두 종료되었습니다.',
            isInternal: false,
            createdAt: now,
          },
        });
        await writeAuditRecord(tx, {
          data: {
            category: 'account',
            action: 'account.merge_request.approved',
            severity: 'warning',
            actorAccountId: adminAccountId,
            subjectType: 'account_merge_request',
            subjectId: request.id,
            metadata: {
              ticketId: request.ticketId,
              sourceAccountCount: sourceGroup.accountIds.length,
              targetAccountCount: lockedTargetGroup.accountIds.length,
              canonicalAccountId,
              conflictFingerprint: request.conflictFingerprint,
              wikiProfileMergeRequestCount: wikiProfileMergeRequestIds.length,
            },
          },
        });
        return serializeRequest(updated);
      },
    );
  }

  async reject(requestId: string, adminAccountId: string, body: unknown) {
    const input = rejectionSchema.parse(body);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM account_merge_requests WHERE id = ${requestId} FOR UPDATE`;
      const request = await tx.accountMergeRequest.findUnique({ where: { id: requestId } });
      if (!request) throw new NotFoundException('계정 병합 요청을 찾을 수 없습니다.');
      if (request.status === 'rejected') return serializeRequest(request);
      if (request.status !== 'pending' || request.version !== input.version) {
        throw new ConflictException('다른 관리자가 계정 병합 요청을 먼저 처리했습니다.');
      }
      const now = new Date();
      const updated = await tx.accountMergeRequest.update({
        where: { id: request.id },
        data: {
          status: 'rejected',
          activeKey: null,
          version: { increment: 1 },
          decidedByAccountId: adminAccountId,
          decisionReason: input.reason,
          decidedAt: now,
        },
      });
      await tx.supportTicket.update({
        where: { id: request.ticketId },
        data: { status: 'resolved', updatedAt: now, lastMessageAt: now },
      });
      await tx.supportMessage.create({
        data: {
          id: randomUUID(),
          ticketId: request.ticketId,
          authorAccountId: adminAccountId,
          authorRole: 'system',
          body: `계정 연결 요청이 반려되었습니다. 사유: ${input.reason}`,
          isInternal: false,
          createdAt: now,
        },
      });
      await writeAuditRecord(tx, {
        data: {
          category: 'account',
          action: 'account.merge_request.rejected',
          severity: 'warning',
          actorAccountId: adminAccountId,
          subjectType: 'account_merge_request',
          subjectId: request.id,
          metadata: { ticketId: request.ticketId, reason: input.reason },
        },
      });
      return serializeRequest(updated);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

async function revokeAuthenticationState(
  tx: Prisma.TransactionClient,
  accountIds: readonly string[],
): Promise<void> {
  await tx.webAuthnChallenge.deleteMany({ where: { accountId: { in: [...accountIds] } } });
  await tx.session.deleteMany({ where: { accountId: { in: [...accountIds] } } });
  await tx.passwordReset.deleteMany({ where: { accountId: { in: [...accountIds] } } });
  await tx.emailVerification.deleteMany({ where: { accountId: { in: [...accountIds] } } });
  await tx.oAuthState.deleteMany({ where: { linkAccountId: { in: [...accountIds] } } });
  await tx.accountEmailChange.updateMany({
    where: { canonicalAccountId: { in: [...accountIds] }, status: 'pending' },
    data: { status: 'superseded', activeKey: null, supersededAt: new Date() },
  });
}

function requireGroup(
  groups: readonly CanonicalAccountGroup[],
  seedAccountId: string,
): CanonicalAccountGroup {
  const group = groups.find((candidate) => candidate.seedAccountId === seedAccountId);
  if (!group) throw new ConflictException('계정 그룹을 잠글 수 없습니다.');
  return group;
}

function assertSnapshotTargets(snapshot: Prisma.JsonValue, candidates: readonly string[]): void {
  if (!Array.isArray(snapshot)) throw new ConflictException('계정 충돌 snapshot이 손상되었습니다.');
  const conflicts = snapshot as unknown as AccountLinkConflict[];
  const targetIds = new Set(conflicts.flatMap((conflict) =>
    conflict?.conflictingAccountId ? [conflict.conflictingAccountId] : [],
  ));
  if (candidates.length === 0 || [...targetIds].length === 0) {
    throw new ConflictException('자동 승인에 필요한 상대 계정 증거가 없습니다.');
  }
}

function serializeRequest(row: {
  id: string;
  ticketId: string;
  requesterAccountId: string;
  sourceCanonicalAccountId: string;
  targetCanonicalAccountId: string | null;
  candidateTargetAccountIds: Prisma.JsonValue;
  conflictSnapshot: Prisma.JsonValue;
  conflictFingerprint: string;
  proofSummary: Prisma.JsonValue | null;
  status: string;
  version: number;
  decidedByAccountId: string | null;
  decisionReason: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    ticketId: row.ticketId,
    requesterAccountId: row.requesterAccountId,
    sourceCanonicalAccountId: row.sourceCanonicalAccountId,
    targetCanonicalAccountId: row.targetCanonicalAccountId,
    candidateTargetAccountIds: jsonStringArray(row.candidateTargetAccountIds),
    conflicts: row.conflictSnapshot,
    conflictFingerprint: row.conflictFingerprint,
    proofSummary: row.proofSummary,
    status: row.status,
    version: row.version,
    decidedByAccountId: row.decidedByAccountId,
    decisionReason: row.decisionReason,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
