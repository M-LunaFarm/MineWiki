import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { verify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { AccountDeletionLegacyIdentityRepository, GuildSettingsRepository } from '../verify/guild.repositories';
import { EmailService } from './email.service';
import { ConfigService } from '@minewiki/config';

const DELETION_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const RECENT_AUTHENTICATION_MS = 15 * 60 * 1000;
const PROCESSING_CLAIM_STALE_MS = 15 * 60 * 1000;

export interface AccountDeletionBlocker {
  readonly type: 'server' | 'server_registration' | 'server_claim' | 'guild' | 'wiki_space' | 'server_wiki' | 'mod_wiki' | 'wiki_role' | 'entitlement' | 'privileged_role';
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

export interface AccountDeletionStatus {
  readonly id: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly scheduledFor: string;
  readonly cancelledAt: string | null;
  readonly processedAt: string | null;
  readonly adminNote: string | null;
}

export interface AccountDeletionAdminItem extends AccountDeletionStatus {
  readonly canonicalAccountId: string;
  readonly accountIds: string[];
  readonly blockers: Prisma.JsonValue;
  readonly requestedBy: string;
  readonly processedBy: string | null;
  readonly version: number;
  readonly updatedAt: string;
}

const ACCOUNT_DELETION_STATUSES = new Set([
  'requested',
  'processing',
  'blocked',
  'cancelled',
  'completed',
  'rejected',
]);

@Injectable()
export class AccountDeletionService {
  private readonly guilds: GuildSettingsRepository;
  private readonly legacyIdentities: AccountDeletionLegacyIdentityRepository;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() guilds?: GuildSettingsRepository,
    @Optional() private readonly email?: EmailService,
    @Optional() private readonly config?: ConfigService,
  ) {
    this.guilds = guilds ?? new GuildSettingsRepository(prisma);
    this.legacyIdentities = new AccountDeletionLegacyIdentityRepository(prisma);
  }

  async getStatus(accountId: string): Promise<AccountDeletionStatus | null> {
    const group = await this.resolveCanonicalGroup(this.prisma, accountId);
    const row = await this.prisma.accountDeletionRequest.findUnique({
      where: { canonicalAccountId: group.canonicalAccountId },
    });
    return row ? toStatus(row) : null;
  }

  async requestDeletion(input: {
    readonly session: SessionPayload;
    readonly password?: string;
    readonly ipAddress?: string | null;
    readonly userAgent?: string | null;
  }): Promise<AccountDeletionStatus & { readonly cancelToken: string }> {
    const group = await this.resolveCanonicalGroup(this.prisma, input.session.userId);
    const reauthMethod = await this.reauthenticate(group.accountIds, input.session, input.password);
    const recoveryEmails = await this.prisma.account.findMany({
      where: { id: { in: group.accountIds }, lifecycleStatus: 'active', emailVerified: true, email: { not: null } },
      select: { email: true },
    });
    const cancelToken = randomBytes(32).toString('base64url');
    const cancelTokenHash = hashToken(cancelToken);
    const now = new Date();
    const scheduledFor = new Date(now.getTime() + DELETION_GRACE_MS);

    const result = await this.prisma.$transaction(async (tx) => {
      const freshGroup = await this.resolveCanonicalGroup(tx, input.session.userId);
      if (freshGroup.canonicalAccountId !== group.canonicalAccountId ||
          !sameIds(freshGroup.accountIds, group.accountIds)) {
        throw new ConflictException('계정 연결 상태가 변경되었습니다. 다시 시도해 주세요.');
      }
      const blockers = await this.listBlockers(tx, freshGroup.accountIds);
      if (blockers.length > 0) {
        throw new ConflictException({
          code: 'ACCOUNT_DELETION_ASSET_TRANSFER_REQUIRED',
          message: '이전해야 할 소유 자산이 있어 계정 종료를 신청할 수 없습니다.',
          blockers,
        });
      }
      const existing = await tx.accountDeletionRequest.findUnique({
        where: { canonicalAccountId: freshGroup.canonicalAccountId },
      });
      if (existing && ['requested', 'processing', 'completed'].includes(existing.status)) {
        throw new ConflictException('이미 진행 중이거나 완료된 계정 종료 요청이 있습니다.');
      }
      const active = await tx.account.updateMany({
        where: { id: { in: freshGroup.accountIds }, lifecycleStatus: 'active' },
        data: { lifecycleStatus: 'deletion_pending', deletionRequestedAt: now },
      });
      if (active.count !== freshGroup.accountIds.length) {
        throw new ConflictException('계정 상태가 동시에 변경되었습니다. 다시 시도해 주세요.');
      }
      const request = existing
        ? await tx.accountDeletionRequest.update({
            where: { id: existing.id },
            data: {
              accountIds: freshGroup.accountIds,
              status: 'requested', reauthMethod, cancelTokenHash,
              blockerSnapshot: [], requestedBy: input.session.userId,
              requestedAt: now, scheduledFor, cancelledAt: null, cancelledBy: null,
              processedAt: null, processedBy: null, adminNote: null,
              version: { increment: 1 },
            },
          })
        : await tx.accountDeletionRequest.create({
            data: {
              canonicalAccountId: freshGroup.canonicalAccountId,
              accountIds: freshGroup.accountIds,
              status: 'requested', reauthMethod, cancelTokenHash,
              blockerSnapshot: [], requestedBy: input.session.userId,
              requestedAt: now, scheduledFor,
            },
          });
      await this.revokeCredentials(tx, freshGroup.accountIds);
      await tx.auditEvent.create({
        data: {
          category: 'account', action: 'account.deletion.requested', severity: 'warning',
          actorAccountId: input.session.userId, subjectType: 'account_deletion_request',
          subjectId: request.id, ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent?.slice(0, 512) ?? null,
          metadata: { canonicalAccountId: freshGroup.canonicalAccountId, accountCount: freshGroup.accountIds.length, scheduledFor: scheduledFor.toISOString(), reauthMethod },
        },
      });
      return request;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    const siteUrl = (this.config?.getOptional('NEXT_PUBLIC_SITE_URL') ?? 'https://minewiki.kr').replace(/\/$/u, '');
    const cancelUrl = `${siteUrl}/account-deletion/cancel#token=${encodeURIComponent(cancelToken)}`;
    for (const email of [...new Set(recoveryEmails.flatMap((row) => row.email ? [row.email] : []))]) {
      await this.email?.sendAccountDeletionCancellationEmail({ email, cancelUrl, scheduledFor }).catch((error) => this.email?.logDeliveryFailure(error));
    }
    return { ...toStatus(result), cancelToken };
  }

  async cancel(cancelToken: string): Promise<AccountDeletionStatus> {
    const tokenHash = hashToken(cancelToken.trim());
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.accountDeletionRequest.findUnique({ where: { cancelTokenHash: tokenHash } });
      if (!request || request.status !== 'requested' || request.scheduledFor <= now) {
        throw new BadRequestException('유효하지 않거나 만료된 계정 종료 취소 토큰입니다.');
      }
      const changed = await tx.accountDeletionRequest.updateMany({
        where: { id: request.id, status: 'requested', version: request.version },
        data: { status: 'cancelled', cancelledAt: now, cancelledBy: 'self:cancel-token', version: { increment: 1 } },
      });
      if (changed.count !== 1) throw new ConflictException('계정 종료 요청 상태가 동시에 변경되었습니다.');
      const accountIds = jsonStringArray(request.accountIds);
      await tx.account.updateMany({
        where: { id: { in: accountIds }, lifecycleStatus: 'deletion_pending' },
        data: { lifecycleStatus: 'active', deletionRequestedAt: null },
      });
      await tx.auditEvent.create({
        data: {
          category: 'account', action: 'account.deletion.cancelled', severity: 'info',
          subjectType: 'account_deletion_request', subjectId: request.id,
          metadata: { canonicalAccountId: request.canonicalAccountId, accountCount: accountIds.length },
        },
      });
      const updated = await tx.accountDeletionRequest.findUnique({ where: { id: request.id } });
      if (!updated) throw new NotFoundException('계정 종료 요청을 찾을 수 없습니다.');
      return toStatus(updated);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async listAdmin(status?: string): Promise<AccountDeletionAdminItem[]> {
    const normalizedStatus = status?.trim();
    if (normalizedStatus && !ACCOUNT_DELETION_STATUSES.has(normalizedStatus)) {
      throw new BadRequestException('지원하지 않는 계정 종료 상태입니다.');
    }
    const rows = await this.prisma.accountDeletionRequest.findMany({
      where: normalizedStatus ? { status: normalizedStatus } : undefined,
      orderBy: [{ requestedAt: 'desc' }], take: 200,
    });
    return rows.map((row) => ({
      ...toStatus(row),
      canonicalAccountId: row.canonicalAccountId,
      accountIds: jsonStringArray(row.accountIds),
      blockers: row.blockerSnapshot,
      requestedBy: row.requestedBy,
      processedBy: row.processedBy,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async process(requestId: string, adminAccountId: string, note?: string): Promise<AccountDeletionStatus> {
    const now = new Date();
    const current = await this.prisma.accountDeletionRequest.findUnique({ where: { id: requestId } });
    if (!current) throw new NotFoundException('계정 종료 요청을 찾을 수 없습니다.');
    if (current.status === 'completed' || (current.status === 'processing' && current.updatedAt > new Date(now.getTime() - PROCESSING_CLAIM_STALE_MS))) {
      return toStatus(current);
    }
    if (!['requested', 'blocked', 'processing'].includes(current.status)) throw new ConflictException('처리 가능한 상태가 아닙니다.');
    if (current.scheduledFor > now) throw new ConflictException('계정 종료 유예기간이 아직 끝나지 않았습니다.');
    const claimed = await this.prisma.accountDeletionRequest.updateMany({
      where: { id: current.id, status: current.status, version: current.version },
      data: { status: 'processing', processedBy: adminAccountId, blockerSnapshot: Prisma.JsonNull, adminNote: cleanNote(note), version: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      const winner = await this.prisma.accountDeletionRequest.findUnique({ where: { id: requestId } });
      if (winner && ['processing', 'completed'].includes(winner.status)) return toStatus(winner);
      throw new ConflictException('다른 관리자가 계정 종료 요청을 먼저 처리했습니다.');
    }
    const claim = await this.prisma.accountDeletionRequest.findUnique({ where: { id: requestId } });
    if (!claim) throw new NotFoundException('계정 종료 요청을 찾을 수 없습니다.');
    let outcome: { blocked: true; blockers: AccountDeletionBlocker[] } | { blocked: false; status: AccountDeletionStatus };
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
      const request = await tx.accountDeletionRequest.findFirst({ where: { id: requestId, status: 'processing', version: claim.version } });
      if (!request) throw new ConflictException('계정 종료 처리 claim이 변경되었습니다.');
      const accountIds = jsonStringArray(request.accountIds);
      const blockers = await this.listBlockers(tx, accountIds);
      if (blockers.length > 0) {
        await tx.accountDeletionRequest.update({
          where: { id: request.id },
          data: { status: 'blocked', blockerSnapshot: blockers as unknown as Prisma.InputJsonValue, adminNote: cleanNote(note), version: { increment: 1 } },
        });
        await tx.auditEvent.create({
          data: { category: 'account', action: 'account.deletion.blocked', severity: 'warning', actorAccountId: adminAccountId, subjectType: 'account_deletion_request', subjectId: request.id, metadata: { blockers } as unknown as Prisma.InputJsonValue },
        });
        return { blocked: true as const, blockers };
      }
      const profiles = await tx.wikiProfile.findMany({
        where: { accountId: { in: accountIds } },
        select: { id: true, username: true },
      });
      const profileIds = profiles.map((item) => item.id);
      const identityCleanup = await this.scrubExternalIdentities(tx, request.id, accountIds);
      await this.revokeCredentials(tx, accountIds);
      await this.anonymizeUserDocuments(tx, request.id, profiles, now);
      const wikiCollaboratorRolesRevoked = await this.revokeWikiCollaboratorRoles(tx, profileIds, now);
      await tx.uploadedFile.updateMany({ where: { ownerAccountId: { in: accountIds } }, data: { ownerAccountId: null } });
      await tx.reviewHelpfulVote.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.reviewReport.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.reviewSubmissionGate.deleteMany({ where: { authorAccountId: { in: accountIds } } });
      await tx.accountConsent.updateMany({ where: { accountId: { in: accountIds } }, data: { ipAddress: null, userAgent: null } });
      await tx.accountRole.deleteMany({ where: { accountId: { in: accountIds } } });
      await tx.accountLink.deleteMany({ where: { OR: [{ primaryAccountId: { in: accountIds } }, { linkedAccountId: { in: accountIds } }] } });
      for (const profile of profiles) {
        await tx.wikiProfile.update({
          where: { id: profile.id },
          data: { accountId: null, username: `deleted-${profile.id}`, displayName: '탈퇴한 사용자', email: null, emailVerifiedAt: null, passwordHash: null, status: 'closed', updatedAt: now },
        });
      }
      if (profileIds.length > 0) {
        await tx.wikiReportSubmission.updateMany({
          where: { reporterProfileId: { in: profileIds } },
          data: { reporterProfileId: null },
        });
        await tx.wikiPageRevision.updateMany({ where: { actorUserId: { in: profileIds } }, data: { actorIp: null, actorIpText: null, actorIpHash: null } });
      }
      for (const accountId of accountIds) {
        await tx.account.update({
          where: { id: accountId },
          data: {
            providerUserId: `deleted:${accountId}`, email: null, displayName: '탈퇴한 사용자',
            avatarUrl: null, emailVerified: false, passwordHash: null, lifecycleStatus: 'anonymized',
            deletionRequestedAt: request.requestedAt, anonymizedAt: now,
          },
        });
      }
      await tx.accountDeletionRequest.update({
        where: { id: request.id },
        data: { status: 'completed', processedAt: now, processedBy: adminAccountId, adminNote: cleanNote(note), version: { increment: 1 } },
      });
      await tx.auditEvent.create({
        data: {
          category: 'account', action: 'account.deletion.completed', severity: 'warning',
          actorAccountId: adminAccountId, subjectType: 'account_deletion_request', subjectId: request.id,
          metadata: { canonicalAccountId: request.canonicalAccountId, accountCount: accountIds.length, wikiProfileCount: profiles.length, wikiCollaboratorRolesRevoked, discordRevocationsQueued: identityCleanup.discordRevocationsQueued, preservation: ['wiki_contributions', 'reviews', 'votes', 'audit_events'] },
        },
      });
      const updated = await tx.accountDeletionRequest.findUnique({ where: { id: request.id } });
      if (!updated) throw new NotFoundException('계정 종료 요청을 찾을 수 없습니다.');
      return { blocked: false as const, status: toStatus(updated) };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      await this.prisma.accountDeletionRequest.updateMany({
        where: { id: requestId, status: 'processing', version: claim.version },
        data: { status: current.status === 'blocked' ? 'blocked' : 'requested', processedBy: null, version: { increment: 1 } },
      });
      throw error;
    }
    if ('blockers' in outcome) {
      throw new ConflictException({ code: 'ACCOUNT_DELETION_ASSET_TRANSFER_REQUIRED', message: '처리 중 이전 필수 자산이 발견되었습니다.', blockers: outcome.blockers });
    }
    return outcome.status;
  }

  async processDue(adminAccountId: string, limitInput?: number): Promise<{ processed: number; blocked: number; failed: number }> {
    const limit = Math.min(Math.max(Number(limitInput) || 50, 1), 200);
    const now = new Date();
    const rows = await this.prisma.accountDeletionRequest.findMany({
      where: {
        scheduledFor: { lte: now },
        OR: [
          { status: { in: ['requested', 'blocked'] } },
          { status: 'processing', updatedAt: { lte: new Date(now.getTime() - PROCESSING_CLAIM_STALE_MS) } },
        ],
      },
      orderBy: [{ scheduledFor: 'asc' }], take: limit, select: { id: true },
    });
    let processed = 0; let blocked = 0; let failed = 0;
    for (const row of rows) {
      try {
        const result = await this.process(row.id, adminAccountId, '자동 유예기간 종료 처리');
        if (result.status === 'completed') processed += 1;
      } catch (error) {
        const code = (error as { getResponse?: () => unknown }).getResponse?.() as { code?: string } | undefined;
        if (code?.code === 'ACCOUNT_DELETION_ASSET_TRANSFER_REQUIRED') blocked += 1;
        else failed += 1;
      }
    }
    return { processed, blocked, failed };
  }

  private async anonymizeUserDocuments(
    tx: Prisma.TransactionClient,
    deletionRequestId: string,
    profiles: ReadonlyArray<{ readonly id: bigint; readonly username: string }>,
    now: Date,
  ): Promise<void> {
    if (profiles.length === 0) return;
    const profileIds = profiles.map((profile) => profile.id);
    const pages = await tx.wikiPage.findMany({
      where: { ownerProfileId: { in: profileIds } },
      select: {
        id: true,
        namespaceId: true,
        ownerProfileId: true,
        localPath: true,
      },
      orderBy: [{ id: 'asc' }],
    });
    await this.closeUserDocumentEditRequests(tx, profiles, now);
    if (pages.length === 0) return;

    const requestKey = deletionRequestId.replace(/[^a-zA-Z0-9]/gu, '').slice(0, 24);
    for (const page of pages) {
      const temporaryPath = `__deleting_${requestKey}_${page.id}`;
      await tx.wikiPage.update({
        where: { id: page.id },
        data: {
          localPath: temporaryPath,
          slug: temporaryPath,
          title: temporaryPath,
          displayTitle: '탈퇴 처리 중인 사용자 문서',
          status: 'deleted',
          updatedAt: now,
        },
      });
    }

    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    for (const page of pages) {
      const profile = profileById.get(page.ownerProfileId ?? -1n);
      if (!profile) continue;
      const rootPath = `deleted-${profile.id}`;
      const wasRoot = !page.localPath.includes('/');
      const finalPath = wasRoot ? rootPath : `${rootPath}/page-${page.id}`;
      await tx.wikiPage.update({
        where: { id: page.id },
        data: {
          localPath: finalPath,
          slug: finalPath,
          title: finalPath,
          displayTitle: wasRoot ? '탈퇴한 사용자' : '탈퇴한 사용자 문서',
          status: 'deleted',
          updatedAt: now,
        },
      });
      await tx.wikiRecentChange.updateMany({
        where: { pageId: page.id },
        data: { title: finalPath },
      });
    }

    const pageIds = pages.map((page) => page.id);
    await tx.wikiPageRenderCache.deleteMany({ where: { pageId: { in: pageIds } } });
    await tx.wikiSearchDocument.deleteMany({ where: { pageId: { in: pageIds } } });
    const userRoots = new Set(profiles.map((profile) => profile.username));
    for (const page of pages) {
      const [root] = page.localPath.split('/');
      if (root) userRoots.add(root);
    }
    for (const root of userRoots) {
      await tx.wikiPageLink.deleteMany({
        where: {
          OR: [
            { sourcePageId: { in: pageIds } },
            {
              targetNamespaceCode: 'user',
              OR: [
                { targetSlug: root },
                { targetSlug: { startsWith: `${root}/` } },
              ],
            },
          ],
        },
      });
    }
  }

  private async closeUserDocumentEditRequests(
    tx: Prisma.TransactionClient,
    profiles: ReadonlyArray<{ readonly id: bigint }>,
    now: Date,
  ): Promise<void> {
    for (const profile of profiles) {
      const tombstone = `deleted-${profile.id}`;
      await tx.wikiEditRequest.updateMany({
        where: {
          targetOwnerProfileId: profile.id,
          status: { in: ['pending', 'reviewing', 'stale'] },
        },
        data: {
          targetTitle: tombstone,
          targetSlug: tombstone,
          targetDisplayTitle: '탈퇴한 사용자 문서',
          status: 'closed',
          updatedAt: now,
        },
      });
    }
  }

  async reject(requestId: string, adminAccountId: string, note: string): Promise<AccountDeletionStatus> {
    const reason = cleanNote(note);
    if (!reason) throw new BadRequestException('반려 사유가 필요합니다.');
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.accountDeletionRequest.findUnique({ where: { id: requestId } });
      if (!request || !['requested', 'blocked'].includes(request.status)) throw new ConflictException('반려 가능한 요청이 아닙니다.');
      const changed = await tx.accountDeletionRequest.updateMany({ where: { id: request.id, version: request.version }, data: { status: 'rejected', adminNote: reason, processedAt: new Date(), processedBy: adminAccountId, version: { increment: 1 } } });
      if (changed.count !== 1) throw new ConflictException('요청 상태가 동시에 변경되었습니다.');
      await tx.account.updateMany({ where: { id: { in: jsonStringArray(request.accountIds) }, lifecycleStatus: 'deletion_pending' }, data: { lifecycleStatus: 'active', deletionRequestedAt: null } });
      await tx.auditEvent.create({ data: { category: 'account', action: 'account.deletion.rejected', severity: 'warning', actorAccountId: adminAccountId, subjectType: 'account_deletion_request', subjectId: request.id, metadata: { reason } } });
      const updated = await tx.accountDeletionRequest.findUnique({ where: { id: request.id } });
      if (!updated) throw new NotFoundException('계정 종료 요청을 찾을 수 없습니다.');
      return toStatus(updated);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async reauthenticate(accountIds: string[], session: SessionPayload, password?: string): Promise<'password' | 'recent_oauth_session'> {
    const accounts = await this.prisma.account.findMany({
      where: { id: { in: accountIds } },
      select: { passwordHash: true },
    });
    if (password?.length) {
      for (const account of accounts) {
        if (account.passwordHash && await verify(account.passwordHash, password)) return 'password';
      }
      throw new UnauthorizedException('현재 비밀번호가 올바르지 않습니다.');
    }
    if (accounts.some((account) => Boolean(account.passwordHash))) {
      throw new ForbiddenException('현재 비밀번호로 다시 인증해 주세요.');
    }
    const authenticatedAt = Date.parse(session.authenticatedAt);
    if (Number.isFinite(authenticatedAt) && Date.now() - authenticatedAt <= RECENT_AUTHENTICATION_MS) return 'recent_oauth_session';
    throw new ForbiddenException('OAuth 전용 계정은 다시 로그인한 뒤 15분 안에 신청해 주세요.');
  }

  private async resolveCanonicalGroup(store: Prisma.TransactionClient | PrismaService, accountId: string) {
    const seed = await store.account.findUnique({ where: { id: accountId }, select: { id: true, canonicalAccountId: true } });
    if (!seed) throw new NotFoundException('계정을 찾을 수 없습니다.');
    const canonicalAccountId = seed.canonicalAccountId ?? seed.id;
    const connected = new Set<string>([seed.id, canonicalAccountId]);
    let frontier = [...connected];
    while (frontier.length > 0) {
      const [links, canonicalRows] = await Promise.all([
        store.accountLink.findMany({
          where: { OR: [{ primaryAccountId: { in: frontier } }, { linkedAccountId: { in: frontier } }] },
          select: { primaryAccountId: true, linkedAccountId: true },
        }),
        store.account.findMany({
          where: { OR: [{ id: { in: frontier } }, { canonicalAccountId: { in: frontier } }] },
          select: { id: true },
        }),
      ]);
      const next: string[] = [];
      for (const id of [...canonicalRows.map((row) => row.id), ...links.flatMap((link) => [link.primaryAccountId, link.linkedAccountId])]) {
        if (!connected.has(id)) { connected.add(id); next.push(id); }
      }
      frontier = next;
    }
    const accountIds = [...connected].sort();
    return { canonicalAccountId, accountIds };
  }

  private async listBlockers(tx: Prisma.TransactionClient, accountIds: string[]): Promise<AccountDeletionBlocker[]> {
    const profiles = await tx.wikiProfile.findMany({ where: { accountId: { in: accountIds } }, select: { id: true } });
    const profileIds = profiles.map((item) => item.id);
    const [servers, registrations, claims, guilds, spaces, roles, privileged, serverWikis, modWikis] = await Promise.all([
      tx.server.findMany({ where: { ownerAccountId: { in: accountIds } }, select: { id: true, name: true } }),
      tx.server.findMany({ where: { ownerAccountId: null, registrantAccountId: { in: accountIds } }, select: { id: true, name: true } }),
      tx.serverClaimMethod.findMany({ where: { accountId: { in: accountIds }, status: { in: ['pending', 'verified'] } }, select: { id: true, serverId: true, method: true, status: true } }),
      this.guilds.listOwnedByAccountIds(accountIds, tx),
      profileIds.length ? tx.wikiSpace.findMany({ where: { OR: [{ ownerUserId: { in: profileIds } }, { createdBy: { in: profileIds } }], status: 'active' }, select: { id: true, title: true, name: true } }) : [],
      profileIds.length ? tx.subwikiRole.findMany({ where: { userId: { in: profileIds }, status: 'active', role: { in: ['owner', 'manager', 'maintainer'] } }, select: { id: true, spaceId: true, role: true } }) : [],
      tx.accountRole.findMany({ where: { accountId: { in: accountIds }, role: { code: { in: ['owner', 'admin'] } } }, select: { id: true, role: { select: { code: true } } } }),
      profileIds.length ? tx.serverWiki.findMany({ where: { createdBy: { in: profileIds }, status: { not: 'deleted' } }, select: { id: true, serverName: true } }) : [],
      profileIds.length ? tx.modWiki.findMany({ where: { verifiedBy: { in: profileIds }, status: 'active' }, select: { id: true, modName: true } }) : [],
    ]);
    const entitlements = serverWikis.length ? await tx.serverWikiLayoutEntitlement.findMany({ where: { serverWikiId: { in: serverWikis.map((item) => item.id) }, status: 'active', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { id: true, layoutKey: true, serverWikiId: true } }) : [];
    return [
      ...servers.map((item) => ({ type: 'server' as const, id: item.id, name: item.name, reason: '서버 소유권을 다른 계정으로 이전해야 합니다.' })),
      ...registrations.map((item) => ({ type: 'server_registration' as const, id: item.id, name: item.name, reason: '미소유 서버 등록 관리 권한을 다른 계정으로 이전하거나 등록을 철회해야 합니다.' })),
      ...claims.map((item) => ({ type: 'server_claim' as const, id: item.id, name: `${item.serverId}:${item.method}`, reason: `${item.status} 서버 소유권 인증을 완료하거나 취소해야 합니다.` })),
      ...guilds.map((item) => ({ type: 'guild' as const, id: item.guildId, name: `Discord 길드 ${item.guildId}`, reason: '길드 관리 소유권을 이전해야 합니다.' })),
      ...spaces.map((item) => ({ type: 'wiki_space' as const, id: item.id.toString(), name: item.title ?? item.name, reason: '위키 공간 소유권을 이전해야 합니다.' })),
      ...serverWikis.map((item) => ({ type: 'server_wiki' as const, id: item.id.toString(), name: item.serverName, reason: '서버 위키 관리 권한을 다른 계정으로 이전해야 합니다.' })),
      ...modWikis.map((item) => ({ type: 'mod_wiki' as const, id: item.id.toString(), name: item.modName, reason: '모드 위키 검증자 권한을 다른 계정으로 이전하거나 해제해야 합니다.' })),
      ...roles.map((item) => ({ type: 'wiki_role' as const, id: item.id.toString(), name: `${item.spaceId}:${item.role}`, reason: '위키 관리자 역할을 이전하거나 해제해야 합니다.' })),
      ...entitlements.map((item) => ({ type: 'entitlement' as const, id: item.id.toString(), name: `${item.layoutKey} 요금제`, reason: '활성 유료 권리를 다른 서버 관리자로 이전하거나 종료해야 합니다.' })),
      ...privileged.map((item) => ({ type: 'privileged_role' as const, id: item.id, name: item.role.code, reason: '보호된 전역 역할을 다른 운영자에게 인계하거나 해제해야 합니다.' })),
    ];
  }

  private async revokeWikiCollaboratorRoles(
    tx: Prisma.TransactionClient,
    profileIds: bigint[],
    now: Date,
  ): Promise<number> {
    if (profileIds.length === 0) return 0;
    const revoked = await tx.subwikiRole.updateMany({
      where: {
        userId: { in: profileIds },
        status: 'active',
        role: { not: 'owner' },
      },
      data: {
        status: 'revoked',
        revokedAt: now,
        // This is a system lifecycle action. The account-deletion audit records
        // the UUID processor; revokedBy is a WikiProfile id and must not falsely
        // attribute the revocation to either the deleting profile or a worker.
        revokedBy: null,
      },
    });
    return revoked.count;
  }

  private async scrubExternalIdentities(
    tx: Prisma.TransactionClient,
    deletionRequestId: string,
    accountIds: string[],
  ): Promise<{ discordRevocationsQueued: number }> {
    const [accountRows, minecraftRows, credentialRows] = await Promise.all([
      tx.account.findMany({
        where: { id: { in: accountIds } },
        select: { provider: true, providerUserId: true, email: true, emailVerified: true },
      }),
      tx.minecraftIdentity.findMany({ where: { accountId: { in: accountIds } }, select: { uuid: true } }),
      tx.oAuthCredential.findMany({ where: { accountId: { in: accountIds }, provider: 'discord' }, select: { providerUserId: true } }),
    ]);
    const discordIds = new Set<string>([
      ...accountRows.filter((row) => row.provider === 'discord').map((row) => row.providerUserId),
      ...credentialRows.map((row) => row.providerUserId),
    ]);
    const minecraftUuids = new Set(minecraftRows.map((row) => row.uuid));

    const legacyLinks = await this.legacyIdentities.listLinks([...discordIds], [...minecraftUuids], tx);
    for (const row of legacyLinks) {
      discordIds.add(row.discordUserId);
      minecraftUuids.add(row.minecraftUuid);
    }

    const verificationSessions = await tx.discordVerificationSession.findMany({
      where: {
        OR: [
          { accountId: { in: accountIds } },
          ...(discordIds.size ? [{ requesterDiscordId: { in: [...discordIds] } }] : []),
          ...(minecraftUuids.size ? [{ minecraftUuid: { in: [...minecraftUuids] } }] : []),
        ],
      },
      select: { id: true, guildId: true, requesterDiscordId: true, minecraftUuid: true, roleId: true, status: true },
    });
    for (const row of verificationSessions) {
      discordIds.add(row.requesterDiscordId);
      if (row.minecraftUuid) minecraftUuids.add(row.minecraftUuid);
    }

    const legacyVerifications = await this.legacyIdentities.listVerifications([...discordIds], [...minecraftUuids], tx);
    for (const row of legacyVerifications) {
      discordIds.add(row.discordUserId);
      minecraftUuids.add(row.minecraftUuid);
    }
    const guildRoles = await this.legacyIdentities.listGuildRoles([...new Set(legacyVerifications.map((row) => row.guildId))], tx);
    const roleByGuild = new Map(guildRoles.map((row) => [row.guildId, row.verifiedRoleId]));
    const revocations = [
      ...verificationSessions.flatMap((row) => row.roleId && row.status !== 'revoked'
        ? [{
            dedupeKey: `session:${row.id}`,
            deletionRequestId,
            verificationSessionId: row.id,
            guildId: row.guildId,
            discordUserId: row.requesterDiscordId,
            roleId: row.roleId,
          }]
        : []),
      ...legacyVerifications.flatMap((row) => {
        const roleId = roleByGuild.get(row.guildId);
        return roleId
          ? [{
              dedupeKey: `legacy:${row.guildId}:${row.discordUserId}`,
              deletionRequestId,
              verificationSessionId: null,
              guildId: row.guildId,
              discordUserId: row.discordUserId,
              roleId,
            }]
          : [];
      }),
    ];
    if (revocations.length > 0) {
      await tx.accountDeletionDiscordRevocation.createMany({ data: revocations, skipDuplicates: true });
    }

    const relatedVotes = await tx.vote.findMany({
      where: {
        OR: [
          { accountId: { in: accountIds } },
          ...(minecraftUuids.size ? [{ minecraftUuid: { in: [...minecraftUuids] } }] : []),
        ],
      },
      select: { usernameNormalized: true },
    });
    await tx.vote.updateMany({
      where: {
        OR: [
          { accountId: { in: accountIds } },
          ...(minecraftUuids.size ? [{ minecraftUuid: { in: [...minecraftUuids] } }] : []),
        ],
      },
      data: { accountId: null, minecraftUuid: null, ipAddress: null, username: '탈퇴한 사용자', usernameNormalized: 'deleted-user' },
    });
    await tx.serverReview.updateMany({
      where: {
        OR: [
          { authorAccountId: { in: accountIds } },
          ...(minecraftUuids.size ? [{ evidenceMinecraftUuid: { in: [...minecraftUuids] } }] : []),
        ],
      },
      data: { authorDisplayName: '탈퇴한 사용자', isAnonymous: true, evidenceMinecraftUuid: null, evidenceVoteId: null, evidenceVerifiedAt: null, evidencePolicyVersion: null },
    });
    const cooldownKeys = [
      ...accountIds.map((id) => `acct:${id}`),
      ...[...minecraftUuids].map((uuid) => `uuid:${uuid}`),
      ...relatedVotes.map((vote) => `user:${vote.usernameNormalized}`),
      ...accountRows.flatMap((account) => {
        const email = account.emailVerified ? account.email?.trim().toLowerCase() : null;
        return email ? [createHash('sha256').update(email).digest('hex')] : [];
      }),
    ];
    if (cooldownKeys.length > 0) await tx.voteCooldownClaim.deleteMany({ where: { identityKey: { in: cooldownKeys } } });

    for (const session of verificationSessions) {
      await tx.discordVerificationSession.update({
        where: { id: session.id },
        data: {
          status: session.roleId && session.status !== 'revoked' ? 'revoke_pending' : 'revoked',
          requesterDiscordId: `deleted:${session.id}`,
          accountId: null,
          minecraftUuid: null,
          minecraftName: null,
          nicknameTemplate: null,
          verificationUrl: null,
          completionTokenHash: null,
          eventLog: Prisma.JsonNull,
          lastSyncStatus: 'account_deleted',
        },
      });
    }
    if (discordIds.size > 0 || minecraftUuids.size > 0) {
      const identityWhere = {
        OR: [
          ...(discordIds.size ? [{ discordUserId: { in: [...discordIds] } }] : []),
          ...(minecraftUuids.size ? [{ minecraftUuid: { in: [...minecraftUuids] } }] : []),
        ],
      };
      await this.legacyIdentities.scrub([...discordIds], [...minecraftUuids], tx);
      await tx.serverPluginSyncEvent.updateMany({
        where: identityWhere,
        data: { discordUserId: null, minecraftUuid: '00000000-0000-0000-0000-000000000000', playerName: null, payload: Prisma.JsonNull },
      });
    }
    return { discordRevocationsQueued: revocations.length };
  }

  private async revokeCredentials(tx: Prisma.TransactionClient, accountIds: string[]): Promise<void> {
    await tx.wikiApiToken.deleteMany({ where: { accountId: { in: accountIds } } });
    await tx.webAuthnChallenge.deleteMany({ where: { accountId: { in: accountIds } } });
    await tx.webAuthnCredential.deleteMany({ where: { accountId: { in: accountIds } } });
    await tx.session.deleteMany({ where: { accountId: { in: accountIds } } });
    await tx.oAuthCredential.deleteMany({ where: { accountId: { in: accountIds } } });
    await tx.oAuthState.deleteMany({ where: { linkAccountId: { in: accountIds } } });
    await tx.passwordReset.deleteMany({ where: { accountId: { in: accountIds } } });
    await tx.emailVerification.deleteMany({ where: { accountId: { in: accountIds } } });
    await tx.minecraftAuthorization.deleteMany({ where: { accountId: { in: accountIds } } });
    await tx.minecraftIdentity.deleteMany({ where: { accountId: { in: accountIds } } });
  }
}

function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
function sameIds(left: string[], right: string[]): boolean { return left.length === right.length && left.every((id, index) => id === right[index]); }
function cleanNote(note?: string): string | null { const value = note?.trim(); return value ? value.slice(0, 1000) : null; }
function jsonStringArray(value: Prisma.JsonValue): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function toStatus(row: { id: string; status: string; requestedAt: Date; scheduledFor: Date; cancelledAt: Date | null; processedAt: Date | null; adminNote: string | null }): AccountDeletionStatus {
  return { id: row.id, status: row.status, requestedAt: row.requestedAt.toISOString(), scheduledFor: row.scheduledFor.toISOString(), cancelledAt: row.cancelledAt?.toISOString() ?? null, processedAt: row.processedAt?.toISOString() ?? null, adminNote: row.adminNote };
}
