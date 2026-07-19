import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type WikiProfile } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { writeAuditEvent } from '../events/audit-event-writer';
import { WikiProfileService } from '../wiki/wiki-profile.service';
import { WikiNotificationService } from '../wiki/wiki-notification.service';
import { EmailService } from '../auth/email.service';

const TRANSFER_TTL_MS = 72 * 60 * 60 * 1_000;
const MAX_ALIAS_DEPTH = 8;

export interface OwnershipTransferActor { readonly accountId: string }
export interface CreateOwnershipTransferInput { readonly targetUsername: string; readonly reason: string }
export interface ManageOwnershipTransferInput { readonly expectedVersion: number; readonly reason: string }
export interface RespondOwnershipTransferInput { readonly expectedVersion: number; readonly reason: string }

export interface OwnershipTransferItem {
  readonly id: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly serverAddress: string;
  readonly sourceOwnerName: string;
  readonly targetUsername: string;
  readonly targetDisplayName: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly version: number;
}

@Injectable()
export class ServerOwnershipTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiProfiles: WikiProfileService,
    private readonly notifications: WikiNotificationService,
    private readonly email: EmailService,
  ) {}

  async current(serverId: string, actor: OwnershipTransferActor): Promise<OwnershipTransferItem | null> {
    const accountId = await this.canonicalAccount(this.prisma, actor.accountId);
    await this.expirePending(new Date(), { serverId });
    const server = await this.prisma.server.findUnique({
      where: { id: serverId }, select: { id: true, ownerAccountId: true, name: true },
    });
    if (!server) throw new NotFoundException('Server not found.');
    if (server.ownerAccountId !== accountId) throw new ForbiddenException('현재 서버 소유자만 이전 요청을 관리할 수 있습니다.');
    const row = await this.prisma.serverOwnershipTransfer.findFirst({
      where: { serverId, status: 'pending', expiresAt: { gt: new Date() } },
      include: { server: { select: { name: true, joinHost: true, joinPort: true, edition: true } } },
    });
    return row ? this.item(this.prisma, row) : null;
  }

  async create(
    serverId: string,
    input: CreateOwnershipTransferInput,
    actor: OwnershipTransferActor,
  ): Promise<OwnershipTransferItem> {
    const username = exactUsername(input.targetUsername);
    const reason = transferReason(input.reason);
    const actorAccountId = await this.canonicalAccount(this.prisma, actor.accountId);
    const sourceProfile = await this.wikiProfiles.ensureWikiProfile(actorAccountId);
    const targetProfileSnapshot = await this.prisma.wikiProfile.findUnique({
      where: { username },
      select: { id: true, accountId: true, status: true, mergedIntoProfileId: true },
    });
    if (!targetProfileSnapshot?.accountId
      || targetProfileSnapshot.status !== 'active'
      || targetProfileSnapshot.mergedIntoProfileId) throw invalidTarget();
    const targetAccountSnapshot = await this.canonicalAccount(this.prisma, targetProfileSnapshot.accountId);
    if (targetAccountSnapshot !== targetProfileSnapshot.accountId) throw invalidTarget();
    const result = await this.serializable(async (tx) => {
      const now = new Date();
      await this.lockCanonicalAccounts(tx, [actorAccountId, targetAccountSnapshot]);
      const server = await this.lockServer(tx, serverId);
      if (server.ownerAccountId !== actorAccountId) throw new ForbiddenException('현재 서버 소유자만 이전을 요청할 수 있습니다.');
      this.assertTransferWindow(server, now);
      await this.lockTransferRows(tx, serverId);
      await this.expirePending(now, { serverId }, tx);
      if (await tx.serverOwnershipTransfer.findFirst({ where: { serverId, status: 'pending' } })) {
        throw new ConflictException('이미 응답을 기다리는 소유권 이전 요청이 있습니다.');
      }
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${sourceProfile.id} FOR UPDATE`;
      const lockedSourceProfile = await tx.wikiProfile.findUnique({
        where: { id: sourceProfile.id },
        select: { accountId: true, status: true, mergedIntoProfileId: true },
      });
      if (lockedSourceProfile?.accountId !== actorAccountId
        || lockedSourceProfile.status !== 'active'
        || lockedSourceProfile.mergedIntoProfileId) throw invalidTarget();
      const target = await this.targetByUsername(tx, username);
      if (target.profile.id !== targetProfileSnapshot.id || target.accountId !== targetAccountSnapshot) throw invalidTarget();
      if (target.accountId === actorAccountId) throw new BadRequestException('자기 자신에게 소유권을 이전할 수 없습니다.');
      await this.assertNoBillingSubject(tx, server);
      const transfer = await tx.serverOwnershipTransfer.create({
        data: {
          serverId, sourceOwnerAccountId: actorAccountId, sourceOwnerProfileId: sourceProfile.id,
          targetAccountId: target.accountId, targetProfileId: target.profile.id,
          reason, status: 'pending', activeServerKey: serverId, requestedAt: now,
          expiresAt: new Date(now.getTime() + TRANSFER_TTL_MS), version: 1,
        },
        include: { server: { select: { name: true, joinHost: true, joinPort: true, edition: true } } },
      });
      await this.audit(tx, 'server.ownership_transfer.request', transfer, actorAccountId, sourceProfile.id, reason, now);
      await this.notifications.notifyServerOwnershipTransferRequested(tx, {
        transferId: transfer.id, targetProfileId: target.profile.id, actorProfileId: sourceProfile.id,
        serverName: server.name, requestedAt: now, version: transfer.version,
      });
      const account = await tx.account.findUnique({
        where: { id: target.accountId }, select: { email: true, emailVerified: true },
      });
      return {
        item: await this.item(tx, transfer),
        delivery: account?.emailVerified && account.email ? {
          transferId: transfer.id,
          transferVersion: transfer.version,
          targetAccountId: target.accountId,
          targetProfileId: target.profile.id,
          email: account.email, serverName: server.name, requesterName: sourceProfile.displayName,
          expiresAt: transfer.expiresAt,
        } : null,
      };
    });
    if (result.delivery && this.email.isEnabled() && await this.canDeliverRequestEmail(result.delivery)) {
      await this.email.sendServerOwnershipTransferRequestEmail(result.delivery)
        .catch((error) => this.email.logDeliveryFailure(error));
    }
    return result.item;
  }

  async cancel(
    serverId: string,
    transferId: string,
    input: ManageOwnershipTransferInput,
    actor: OwnershipTransferActor,
  ): Promise<{ readonly status: 'cancelled' }> {
    const expectedVersion = version(input.expectedVersion);
    const reason = transferReason(input.reason);
    const accountId = await this.canonicalAccount(this.prisma, actor.accountId);
    const profile = await this.wikiProfiles.ensureWikiProfile(accountId);
    return this.serializable(async (tx) => {
      await this.lockCanonicalAccounts(tx, [accountId]);
      const server = await this.lockServer(tx, serverId);
      if (server.ownerAccountId !== accountId) throw new ForbiddenException('현재 서버 소유자만 요청을 취소할 수 있습니다.');
      await this.lockTransferRows(tx, serverId);
      const row = await tx.serverOwnershipTransfer.findUnique({ where: { id: transferId }, include: { server: { select: { name: true, joinHost: true, joinPort: true, edition: true } } } });
      this.assertPending(row, serverId, expectedVersion);
      const now = new Date();
      const changed = await tx.serverOwnershipTransfer.updateMany({
        where: { id: transferId, serverId, status: 'pending', version: expectedVersion, expiresAt: { gt: now } },
        data: { status: 'cancelled', activeServerKey: null, cancelledAt: now, respondedAt: now,
          cancelledByProfileId: profile.id, cancelReason: reason, version: { increment: 1 } },
      });
      if (changed.count !== 1) throw staleTransfer();
      await this.audit(tx, 'server.ownership_transfer.cancel', row!, accountId, profile.id, reason, now);
      await this.notifications.notifyServerOwnershipTransferChanged(tx, {
        transferId, recipientProfileId: row!.targetProfileId, actorProfileId: profile.id,
        serverId, serverName: server.name, state: 'cancelled', changedAt: now, version: expectedVersion + 1,
      });
      return { status: 'cancelled' as const };
    });
  }

  async mine(actor: OwnershipTransferActor): Promise<readonly OwnershipTransferItem[]> {
    const accountId = await this.canonicalAccount(this.prisma, actor.accountId);
    await this.expirePending(new Date(), { targetAccountId: accountId });
    const rows = await this.prisma.serverOwnershipTransfer.findMany({
      where: { targetAccountId: accountId, status: 'pending', expiresAt: { gt: new Date() } },
      include: { server: { select: { name: true, joinHost: true, joinPort: true, edition: true } } },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: 100,
    });
    return Promise.all(rows.map((row) => this.item(this.prisma, row)));
  }

  async respond(
    transferId: string,
    action: 'accept' | 'decline',
    input: RespondOwnershipTransferInput,
    actor: OwnershipTransferActor,
  ): Promise<{ readonly status: 'accepted' | 'declined'; readonly serverId: string }> {
    const expectedVersion = version(input.expectedVersion);
    const reason = transferReason(input.reason);
    const accountId = await this.canonicalAccount(this.prisma, actor.accountId);
    const profile = await this.wikiProfiles.ensureWikiProfile(accountId);
    const lookup = await this.prisma.serverOwnershipTransfer.findUnique({
      where: { id: transferId },
      select: { serverId: true, sourceOwnerAccountId: true, targetAccountId: true },
    });
    if (!lookup) throw new NotFoundException('소유권 이전 요청을 찾을 수 없습니다.');
    return this.serializable(async (tx) => {
      await this.lockCanonicalAccounts(tx, [lookup.sourceOwnerAccountId, lookup.targetAccountId]);
      const server = await this.lockServer(tx, lookup.serverId);
      await this.lockTransferRows(tx, server.id);
      const row = await tx.serverOwnershipTransfer.findUnique({ where: { id: transferId }, include: { server: { select: { name: true, joinHost: true, joinPort: true, edition: true } } } });
      this.assertPending(row, server.id, expectedVersion);
      if (row!.sourceOwnerAccountId !== lookup.sourceOwnerAccountId
        || row!.targetAccountId !== lookup.targetAccountId) throw staleTransfer('요청 계정 상태가 변경되었습니다.');
      if (row!.targetAccountId !== accountId || row!.targetProfileId !== profile.id) {
        throw new NotFoundException('소유권 이전 요청을 찾을 수 없습니다.');
      }
      const now = new Date();
      if (row!.expiresAt <= now) throw staleTransfer('소유권 이전 요청이 만료되었습니다.');
      if (server.ownerAccountId !== row!.sourceOwnerAccountId) throw staleTransfer('요청 이후 서버 소유자가 변경되었습니다.');
      this.assertTransferWindow(server, now);
      const target = await this.targetByProfile(tx, row!.targetProfileId);
      if (target.accountId !== accountId) throw staleTransfer('대상 계정 상태가 변경되었습니다.');
      await this.assertNoBillingSubject(tx, server);

      const status = action === 'accept' ? 'accepted' : 'declined';
      const changed = await tx.serverOwnershipTransfer.updateMany({
        where: { id: transferId, status: 'pending', version: expectedVersion, expiresAt: { gt: now } },
        data: { status, activeServerKey: null, respondedAt: now, cancelReason: reason, version: { increment: 1 } },
      });
      if (changed.count !== 1) throw staleTransfer();
      if (action === 'accept') await this.completeTransfer(tx, server, row!, profile, now);
      await this.audit(tx, `server.ownership_transfer.${action}`, row!, accountId, profile.id, reason, now);
      await this.notifications.notifyServerOwnershipTransferChanged(tx, {
        transferId, recipientProfileId: row!.sourceOwnerProfileId, actorProfileId: profile.id,
        serverId: server.id, serverName: server.name, state: status,
        changedAt: now, version: expectedVersion + 1,
      });
      return { status, serverId: server.id };
    });
  }

  private async completeTransfer(
    tx: Prisma.TransactionClient,
    server: LockedServer,
    transfer: { id: string; sourceOwnerAccountId: string; sourceOwnerProfileId: bigint; targetAccountId: string; targetProfileId: bigint },
    targetProfile: WikiProfile,
    now: Date,
  ): Promise<void> {
    const updated = await tx.server.updateMany({
      where: { id: server.id, ownerAccountId: transfer.sourceOwnerAccountId,
        ownershipChallengeStartedAt: null, ownershipChallengeSuspendedAt: null },
      data: { ownerAccountId: transfer.targetAccountId, registrantAccountId: null, registrationLeaseExpiresAt: null },
    });
    if (updated.count !== 1) throw staleTransfer('서버 소유권이 동시에 변경되었습니다.');
    if (server.wikiSpaceId) {
      await tx.$queryRaw`SELECT id FROM wiki_spaces WHERE id = ${server.wikiSpaceId} FOR UPDATE`;
      const space = await tx.wikiSpace.findUnique({ where: { id: server.wikiSpaceId }, select: { id: true, spaceType: true, status: true, ownerUserId: true } });
      if (!space || space.spaceType !== 'server_wiki' || space.status !== 'active'
        || space.ownerUserId !== transfer.sourceOwnerProfileId) {
        throw staleTransfer('연결된 서버 위키 소유권 상태가 올바르지 않습니다.');
      }
      await tx.$queryRaw`SELECT id FROM subwiki_roles WHERE space_id = ${space.id} ORDER BY id FOR UPDATE`;
      const ownerRoles = await tx.subwikiRole.findMany({
        where: { spaceId: space.id, status: 'active', role: 'owner' }, select: { userId: true },
      });
      if (ownerRoles.length !== 1 || ownerRoles[0]?.userId !== transfer.sourceOwnerProfileId) {
        throw staleTransfer('서버 위키 소유자 역할이 일치하지 않습니다.');
      }
      await tx.subwikiRole.updateMany({
        where: { spaceId: space.id, userId: { in: [transfer.sourceOwnerProfileId, transfer.targetProfileId] }, status: 'active' },
        data: { status: 'revoked', revokedAt: now, revokedBy: targetProfile.id },
      });
      await tx.subwikiRole.upsert({
        where: { spaceId_userId_role: { spaceId: space.id, userId: transfer.targetProfileId, role: 'owner' } },
        update: { status: 'active', grantedAt: now, grantedBy: targetProfile.id, revokedAt: null, revokedBy: null },
        create: { spaceId: space.id, userId: transfer.targetProfileId, role: 'owner', status: 'active', grantedAt: now, grantedBy: targetProfile.id },
      });
      await tx.wikiSpace.update({ where: { id: space.id }, data: { ownerUserId: transfer.targetProfileId, updatedAt: now } });
      const wiki = await tx.serverWiki.findUnique({ where: { spaceId: space.id }, select: { id: true, voteServerId: true, status: true } });
      if (!wiki || wiki.voteServerId !== server.id || wiki.status !== 'active') throw staleTransfer('연결된 서버 위키를 찾을 수 없습니다.');
      await tx.serverWikiCollaboratorInvitation.updateMany({
        where: { serverWikiId: wiki.id, status: 'pending', OR: [
          { issuedUnderOwnerId: transfer.sourceOwnerAccountId }, { targetAccountId: transfer.targetAccountId },
        ] },
        data: { status: 'cancelled', activeKey: null, respondedAt: now,
          cancelReason: '서버 소유권 이전으로 기존 초대가 취소되었습니다.', version: { increment: 1 } },
      });
      await tx.wikiApiToken.updateMany({
        where: { accountId: transfer.sourceOwnerAccountId, spaceId: space.id, status: 'active' },
        data: { status: 'revoked', revokedAt: now },
      });
    }
    await tx.serverClaimMethod.updateMany({
      where: { serverId: server.id, accountId: transfer.sourceOwnerAccountId },
      data: {
        status: 'expired',
        verifiedAt: null,
        note: 'ownership_transfer',
        version: { increment: 1 },
        lastCheckedAt: now,
      },
    });
  }

  private async canDeliverRequestEmail(delivery: {
    readonly transferId: string;
    readonly transferVersion: number;
    readonly targetAccountId: string;
    readonly targetProfileId: bigint;
    readonly email: string;
  }): Promise<boolean> {
    const now = new Date();
    const transfer = await this.prisma.serverOwnershipTransfer.findUnique({
      where: { id: delivery.transferId },
      select: {
        status: true,
        version: true,
        expiresAt: true,
        targetAccountId: true,
        targetProfileId: true,
      },
    });
    if (!transfer
      || transfer.status !== 'pending'
      || transfer.version !== delivery.transferVersion
      || transfer.expiresAt <= now
      || transfer.targetAccountId !== delivery.targetAccountId
      || transfer.targetProfileId !== delivery.targetProfileId) return false;
    const [profile, account] = await Promise.all([
      this.prisma.wikiProfile.findUnique({
        where: { id: delivery.targetProfileId },
        select: { accountId: true, status: true, mergedIntoProfileId: true },
      }),
      this.prisma.account.findUnique({
        where: { id: delivery.targetAccountId },
        select: { id: true, email: true, emailVerified: true, lifecycleStatus: true, canonicalAccountId: true },
      }),
    ]);
    return profile?.status === 'active'
      && profile.mergedIntoProfileId === null
      && profile.accountId === delivery.targetAccountId
      && account?.lifecycleStatus === 'active'
      && (!account.canonicalAccountId || account.canonicalAccountId === account.id)
      && account.emailVerified
      && account.email === delivery.email;
  }

  private async lockServer(tx: Prisma.TransactionClient, serverId: string): Promise<LockedServer> {
    await tx.$queryRaw`SELECT id FROM \`Server\` WHERE id = ${serverId} FOR UPDATE`;
    const server = await tx.server.findUnique({ where: { id: serverId }, select: {
      id: true, name: true, ownerAccountId: true, registrantAccountId: true, registrationLeaseExpiresAt: true,
      ownershipChallengeStartedAt: true, ownershipChallengeExpiresAt: true, ownershipChallengeSuspendedAt: true,
      wikiSpaceId: true,
    } });
    if (!server) throw new NotFoundException('Server not found.');
    return server;
  }

  private assertTransferWindow(server: LockedServer, now: Date): void {
    if (server.ownershipChallengeStartedAt || server.ownershipChallengeExpiresAt || server.ownershipChallengeSuspendedAt) {
      throw new ConflictException('소유권 재검증이 진행 중인 서버는 이전할 수 없습니다.');
    }
    if (server.registrantAccountId && server.registrationLeaseExpiresAt && server.registrationLeaseExpiresAt > now) {
      throw new ConflictException('다른 등록 또는 인수 절차가 진행 중인 서버는 이전할 수 없습니다.');
    }
  }

  private async assertNoBillingSubject(tx: Prisma.TransactionClient, server: LockedServer): Promise<void> {
    if (!server.wikiSpaceId) return;
    await tx.$queryRaw`SELECT id FROM server_wikis WHERE space_id = ${server.wikiSpaceId} FOR UPDATE`;
    const wiki = await tx.serverWiki.findUnique({ where: { spaceId: server.wikiSpaceId }, select: { billingSubject: { select: { id: true } } } });
    if (wiki?.billingSubject) {
      throw new ConflictException('결제 고객 정보 또는 구독 이력이 있는 서버는 개인정보 보호를 위해 자동 이전할 수 없습니다. 고객 지원에 문의해 주세요.');
    }
  }

  private async targetByUsername(tx: Prisma.TransactionClient, username: string) {
    await tx.$queryRaw`SELECT id FROM users WHERE username = ${username} FOR UPDATE`;
    const profile = await tx.wikiProfile.findUnique({ where: { username } });
    if (!profile || profile.username !== username) throw new NotFoundException('정확히 일치하는 활성 MineWiki 사용자를 찾을 수 없습니다.');
    return this.targetByProfile(tx, profile.id);
  }

  private async targetByProfile(tx: Prisma.TransactionClient, profileId: bigint) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${profileId} FOR UPDATE`;
    const profile = await tx.wikiProfile.findUnique({ where: { id: profileId } });
    if (!profile || profile.status !== 'active' || profile.mergedIntoProfileId || !profile.accountId) throw invalidTarget();
    const alias = await tx.wikiProfileAlias.findUnique({ where: { sourceProfileId: profile.id } });
    if (alias) throw invalidTarget();
    const accountId = await this.lockCanonicalAccount(tx, profile.accountId);
    if (accountId !== profile.accountId) throw invalidTarget();
    return { profile, accountId };
  }

  private async canonicalAccount(store: PrismaService | Prisma.TransactionClient, initial: string): Promise<string> {
    let id = initial;
    const seen = new Set<string>();
    for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth += 1) {
      if (seen.has(id)) throw invalidTarget();
      seen.add(id);
      const account = await store.account.findUnique({ where: { id }, select: { id: true, canonicalAccountId: true, lifecycleStatus: true } });
      if (!account || account.lifecycleStatus !== 'active') throw invalidTarget();
      const next = account.canonicalAccountId ?? account.id;
      if (next === account.id) return account.id;
      id = next;
    }
    throw invalidTarget();
  }

  private async lockCanonicalAccount(tx: Prisma.TransactionClient, initial: string): Promise<string> {
    let id = initial;
    const seen = new Set<string>();
    for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth += 1) {
      if (seen.has(id)) throw invalidTarget();
      seen.add(id);
      await tx.$queryRaw`SELECT id FROM \`Account\` WHERE id = ${id} FOR UPDATE`;
      const account = await tx.account.findUnique({
        where: { id }, select: { id: true, canonicalAccountId: true, lifecycleStatus: true },
      });
      if (!account || account.lifecycleStatus !== 'active') throw invalidTarget();
      const next = account.canonicalAccountId ?? account.id;
      if (next === account.id) return account.id;
      id = next;
    }
    throw invalidTarget();
  }

  private async lockCanonicalAccounts(tx: Prisma.TransactionClient, accountIds: readonly string[]): Promise<void> {
    for (const accountId of [...new Set(accountIds)].sort()) {
      if (await this.lockCanonicalAccount(tx, accountId) !== accountId) throw invalidTarget();
    }
  }

  private async item(store: PrismaService | Prisma.TransactionClient, row: TransferWithServer): Promise<OwnershipTransferItem> {
    const profiles = await store.wikiProfile.findMany({
      where: { id: { in: [row.sourceOwnerProfileId, row.targetProfileId] } },
      select: { id: true, username: true, displayName: true },
    });
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));
    const source = byId.get(row.sourceOwnerProfileId);
    const target = byId.get(row.targetProfileId);
    if (!source || !target) throw staleTransfer('이전 요청의 계정 정보를 확인할 수 없습니다.');
    return {
      id: row.id, serverId: row.serverId, serverName: row.server.name,
      serverAddress: formatServerAddress(row.server.joinHost, row.server.joinPort, row.server.edition),
      sourceOwnerName: source.displayName, targetUsername: target.username,
      targetDisplayName: target.displayName, reason: row.reason,
      requestedAt: row.requestedAt.toISOString(), expiresAt: row.expiresAt.toISOString(), version: row.version,
    };
  }

  private async audit(tx: Prisma.TransactionClient, action: string, row: TransferWithServer,
    actorAccountId: string, actorProfileId: bigint, reason: string, now: Date): Promise<void> {
    await writeAuditEvent(tx, action, { category: 'server', severity: action.endsWith('.accept') ? 'warning' : 'info',
      actorAccountId, actorProfileId, subjectType: 'server_ownership_transfer', subjectId: row.id, createdAt: now,
      metadata: { serverId: row.serverId, sourceOwnerAccountId: row.sourceOwnerAccountId,
        sourceOwnerProfileId: row.sourceOwnerProfileId, targetAccountId: row.targetAccountId,
        targetProfileId: row.targetProfileId, reason, version: row.version },
    });
  }

  private lockTransfer(tx: Prisma.TransactionClient, id: string) {
    return tx.$queryRaw`SELECT id FROM server_ownership_transfers WHERE id = ${id} FOR UPDATE`;
  }
  private lockTransferRows(tx: Prisma.TransactionClient, serverId: string) {
    return tx.$queryRaw`SELECT id FROM server_ownership_transfers WHERE server_id = ${serverId} ORDER BY id FOR UPDATE`;
  }
  private assertPending(row: TransferWithServer | null, serverId: string, expectedVersion: number): void {
    if (!row || row.serverId !== serverId) throw new NotFoundException('소유권 이전 요청을 찾을 수 없습니다.');
    if (row.status !== 'pending' || row.version !== expectedVersion) throw staleTransfer();
  }
  private async expirePending(now: Date, where: { serverId?: string; targetAccountId?: string }, store: PrismaService | Prisma.TransactionClient = this.prisma) {
    await store.serverOwnershipTransfer.updateMany({ where: { ...where, status: 'pending', expiresAt: { lte: now } },
      data: { status: 'expired', activeServerKey: null, respondedAt: now, version: { increment: 1 } } });
  }
  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : null;
      if (code === 'P2002' || code === 'P2034') throw staleTransfer();
      throw error;
    }
  }
}

type LockedServer = {
  readonly id: string; readonly name: string; readonly ownerAccountId: string | null;
  readonly registrantAccountId: string | null; readonly registrationLeaseExpiresAt: Date | null;
  readonly ownershipChallengeStartedAt: Date | null; readonly ownershipChallengeExpiresAt: Date | null;
  readonly ownershipChallengeSuspendedAt: Date | null; readonly wikiSpaceId: bigint | null;
};
type TransferWithServer = Prisma.ServerOwnershipTransferGetPayload<{
  include: { server: { select: { name: true; joinHost: true; joinPort: true; edition: true } } };
}>;

function formatServerAddress(host: string, port: number, edition: string): string {
  const defaultPort = edition === 'bedrock' ? 19132 : 25565;
  return port === defaultPort ? host : `${host}:${port}`;
}

function exactUsername(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || value.normalize('NFKC') !== value) {
    throw new BadRequestException('대상 사용자명을 정확히 입력해 주세요.');
  }
  return value;
}
function transferReason(value: string): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < 5 || reason.length > 500) throw new BadRequestException('사유는 5~500자로 입력해 주세요.');
  return reason;
}
function version(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) throw new BadRequestException('유효한 버전이 필요합니다.');
  return value;
}
function invalidTarget() { return new ConflictException('대상 계정 또는 프로필이 활성 canonical 상태가 아닙니다.'); }
function staleTransfer(message = '소유권 이전 요청이 이미 처리되었거나 변경되었습니다.') { return new ConflictException(message); }
