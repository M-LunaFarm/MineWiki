import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { verify } from '@node-rs/argon2';
import { PrismaService } from '../common/prisma.service';
import { writeAuditRecord } from '../events/audit-event-writer';
import {
  assertFreshStepUp,
  type SessionPayload,
} from '../session/session.service';
import {
  readCanonicalAccountGroup,
  type CanonicalAccountGroup,
} from './account-lifecycle-fence';
import {
  buildAccountExportSections,
  type AccountExportScope,
} from './account-export-sections';
import { createAccountExportStream } from './account-export-stream';
import {
  WikiPermissionService,
  type WikiPermissionActor,
} from '../wiki/wiki-permission.service';

const RECENT_OAUTH_MS = 15 * 60 * 1000;

@Injectable()
export class AccountDataExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiPermissions: WikiPermissionService,
  ) {}

  async create(input: { readonly session: SessionPayload; readonly password?: string }) {
    const group = await this.resolveActiveGroup(input.session.userId);
    await this.reauthenticate(group, input.session, input.password);
    const scope = await this.resolveScope(group);

    // Close the small authorization race without holding a transaction open while the file streams.
    const confirmed = await this.resolveActiveGroup(input.session.userId);
    if (!sameScope(group, confirmed)) {
      throw new ConflictException('계정 연결 상태가 변경되었습니다. 다시 시도해 주세요.');
    }

    const generatedAt = new Date();
    await writeAuditRecord(this.prisma, {
      data: {
        category: 'account',
        action: 'account.data_export.started',
        severity: 'info',
        actorAccountId: input.session.userId,
        subjectType: 'account',
        subjectId: scope.canonicalAccountId,
        metadata: { accountCount: scope.accountIds.length, profileCount: scope.profileIds.length },
      },
    });

    const visibility = await this.createWikiVisibilityFilters(input.session, scope);
    const stream = createAccountExportStream({
      generatedAt,
      canonicalAccountId: scope.canonicalAccountId,
      accountIds: scope.accountIds,
      profileIds: scope.profileIds.map(String),
    }, buildAccountExportSections(
      this.prisma,
      scope,
      visibility.filterPageIds,
      visibility.filterThreadIds,
    ));
    stream.once('end', () => void this.recordOutcome(input.session.userId, scope.canonicalAccountId, 'completed'));
    stream.once('error', () => void this.recordOutcome(input.session.userId, scope.canonicalAccountId, 'failed'));
    return stream;
  }

  private async resolveActiveGroup(accountId: string): Promise<CanonicalAccountGroup> {
    const group = await readCanonicalAccountGroup(this.prisma, accountId);
    const activeCount = await this.prisma.account.count({
      where: { id: { in: [...group.accountIds] }, lifecycleStatus: 'active' },
    });
    if (activeCount !== group.accountIds.length) {
      throw new ConflictException({
        code: 'ACCOUNT_EXPORT_ACCOUNT_INACTIVE',
        message: '종료 또는 제한 절차가 진행 중인 계정은 먼저 계정 상태를 복구한 뒤 내보낼 수 있습니다.',
      });
    }
    return group;
  }

  private async reauthenticate(
    group: CanonicalAccountGroup,
    session: SessionPayload,
    password?: string,
  ): Promise<void> {
    try {
      assertFreshStepUp(session, 'account_export');
      return;
    } catch (error) {
      if (!(error instanceof ForbiddenException)) throw error;
    }

    const accounts = await this.prisma.account.findMany({
      where: { id: { in: [...group.accountIds] } },
      select: { passwordHash: true },
    });
    const passwordHashes = accounts.flatMap((account) =>
      account.passwordHash ? [account.passwordHash] : []
    );
    if (passwordHashes.length > 0) {
      if (!password) throw reauthRequired('현재 비밀번호 또는 다중 인증 확인이 필요합니다.');
      for (const hash of passwordHashes) {
        if (await verify(hash, password)) return;
      }
      throw new UnauthorizedException({
        code: 'ACCOUNT_EXPORT_PASSWORD_INVALID',
        message: '현재 비밀번호가 올바르지 않습니다.',
      });
    }

    const authenticatedAt = Date.parse(session.authenticatedAt);
    const now = Date.now();
    if (
      Number.isFinite(authenticatedAt) &&
      authenticatedAt <= now &&
      now - authenticatedAt <= RECENT_OAUTH_MS
    ) return;
    throw reauthRequired('OAuth 계정은 다시 로그인한 뒤 15분 안에 내보내거나 다중 인증을 확인해 주세요.');
  }

  private async resolveScope(group: CanonicalAccountGroup): Promise<AccountExportScope> {
    const profiles = await this.prisma.wikiProfile.findMany({
      where: { accountId: { in: [...group.accountIds] } },
      select: { id: true },
    });
    const profileIds = new Set(profiles.map((profile) => profile.id));
    let frontier = [...profileIds];
    while (frontier.length > 0) {
      const aliases = await this.prisma.wikiProfileAlias.findMany({
        where: { targetProfileId: { in: frontier } },
        select: { sourceProfileId: true, mergeRequestId: true },
      });
      const mergeIds = aliases.map((alias) => alias.mergeRequestId);
      const completed = mergeIds.length === 0 ? [] : await this.prisma.wikiProfileMergeRequest.findMany({
        where: {
          id: { in: mergeIds },
          canonicalAccountId: group.canonicalAccountId,
          status: 'completed',
        },
        select: { id: true },
      });
      const completedIds = new Set(completed.map((request) => request.id));
      const next: bigint[] = [];
      for (const alias of aliases) {
        if (!completedIds.has(alias.mergeRequestId) || profileIds.has(alias.sourceProfileId)) continue;
        profileIds.add(alias.sourceProfileId);
        next.push(alias.sourceProfileId);
      }
      frontier = next;
    }
    return {
      accountIds: [...group.accountIds],
      canonicalAccountId: group.canonicalAccountId,
      profileIds: [...profileIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    };
  }

  private async createWikiVisibilityFilters(session: SessionPayload, scope: AccountExportScope) {
    const profiles = await this.prisma.wikiProfile.findMany({
      where: { id: { in: [...scope.profileIds] }, status: 'active', accountId: { not: null } },
      orderBy: { id: 'asc' },
      select: { id: true, accountId: true, status: true },
    });
    const preferred = profiles.find((profile) => profile.accountId === session.userId) ?? profiles[0];
    const actor: WikiPermissionActor | null = preferred?.accountId ? {
      accountId: preferred.accountId,
      profileId: preferred.id,
      status: preferred.status,
      isElevated: session.isElevated,
      permissions: session.permissions,
      groups: session.groups,
      requestIp: session.requestIp,
    } : null;

    const loadPages = (pageIds: readonly bigint[]) => this.prisma.wikiPage.findMany({
      where: { id: { in: [...new Set(pageIds)] } },
      select: {
        id: true, namespaceId: true, spaceId: true, title: true,
        protectionLevel: true, status: true, createdBy: true, ownerProfileId: true,
      },
    });
    const filterPageIds = async (pageIds: readonly bigint[]): Promise<ReadonlySet<bigint>> => {
      const uniqueIds = [...new Set(pageIds)];
      if (uniqueIds.length === 0) return new Set();
      const pages = await loadPages(uniqueIds);
      const readable = await this.wikiPermissions.filterReadablePages({
        accountId: actor?.accountId ?? session.userId,
        actor,
        pages,
        requestIp: session.requestIp,
      });
      return new Set(readable.map((page) => page.id));
    };
    const filterThreadIds = async (threadIds: readonly bigint[]): Promise<ReadonlySet<bigint>> => {
      const uniqueIds = [...new Set(threadIds)];
      if (uniqueIds.length === 0) return new Set();
      const threads = await this.prisma.wikiDiscussionThread.findMany({
        where: { id: { in: uniqueIds } },
        select: { id: true, pageId: true, status: true },
      });
      const pages = await loadPages(threads.map((thread) => thread.pageId));
      const pageById = new Map(pages.map((page) => [page.id, page]));
      const items = threads.flatMap((thread) => {
        const page = pageById.get(thread.pageId);
        return page ? [{ thread, page }] : [];
      });
      const readable = await this.wikiPermissions.filterReadableThreads({
        accountId: actor?.accountId ?? session.userId,
        actor,
        items,
      });
      return new Set(readable.map((item) => item.thread.id));
    };
    return { filterPageIds, filterThreadIds };
  }

  private async recordOutcome(accountId: string, canonicalAccountId: string, outcome: 'completed' | 'failed') {
    await writeAuditRecord(this.prisma, {
      data: {
        category: 'account',
        action: `account.data_export.${outcome}`,
        severity: outcome === 'completed' ? 'info' : 'warning',
        actorAccountId: accountId,
        subjectType: 'account',
        subjectId: canonicalAccountId,
      },
    }).catch(() => undefined);
  }
}

function reauthRequired(message: string): ForbiddenException {
  return new ForbiddenException({ code: 'ACCOUNT_EXPORT_REAUTH_REQUIRED', purpose: 'account_export', message });
}

function sameScope(left: CanonicalAccountGroup, right: CanonicalAccountGroup): boolean {
  return left.canonicalAccountId === right.canonicalAccountId &&
    left.accountIds.length === right.accountIds.length &&
    left.accountIds.every((id, index) => id === right.accountIds[index]);
}
