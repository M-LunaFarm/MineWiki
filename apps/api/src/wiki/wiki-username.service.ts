import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { verify } from '@node-rs/argon2';
import { collectWikiFileNames, parseMarkup } from '@minewiki/wiki-core';
import { Prisma, type WikiPage, type WikiPageRevision } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { readCanonicalAccountGroup, type CanonicalAccountGroup } from '../auth/account-lifecycle-fence';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { wikiLinkResolutionContext } from './wiki-link-context';
import { WikiLinkIndexService } from './wiki-link-index.service';
import { WikiProfileService } from './wiki-profile.service';

const COOLDOWN_DAYS = 30;
const COOLDOWN_MS = COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const RECENT_OAUTH_MS = 15 * 60 * 1000;
const USERNAME_PATTERN = /^[가-힣A-Za-z0-9_-]{2,32}$/u;
const RESERVED_USERNAMES = new Set([
  'account', 'accounts', 'admin', 'administrator', 'api', 'auth', 'category', 'data', 'dev',
  'file', 'guide', 'help', 'login', 'logout', 'me', 'minewiki', 'mod', 'modpack', 'null',
  'profile', 'profiles', 'project', 'register', 'root', 'server', 'settings', 'signup', 'special',
  'support', 'system', 'template', 'undefined', 'user', 'wiki',
]);

export interface WikiUsernameStateResponse {
  readonly username: string;
  readonly changedAt: string | null;
  readonly nextChangeAt: string | null;
  readonly canChange: boolean;
  readonly cooldownDays: number;
  readonly documentCount: number;
}

export interface WikiUsernameChangeRequest {
  readonly username?: string;
  readonly password?: string;
  readonly confirmation?: string;
}

export interface WikiUsernameChangeResponse extends WikiUsernameStateResponse {
  readonly previousUsername: string;
  readonly movedDocumentCount: number;
}

@Injectable()
export class WikiUsernameService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiProfiles: WikiProfileService,
    private readonly wikiLinks: WikiLinkIndexService,
  ) {}

  async getState(session: SessionPayload): Promise<WikiUsernameStateResponse> {
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const namespace = await this.prisma.wikiNamespace.findUnique({ where: { code: 'user' }, select: { id: true } });
    const documentCount = namespace ? await this.prisma.wikiPage.count({
      where: { namespaceId: namespace.id, ownerProfileId: profile.id, status: { not: 'deleted' } },
    }) : 0;
    return this.state(profile, documentCount);
  }

  async change(session: SessionPayload, input: WikiUsernameChangeRequest): Promise<WikiUsernameChangeResponse> {
    const username = this.validateUsername(input.username);
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    if (input.confirmation !== profile.username) {
      throw new BadRequestException({
        code: 'wiki_username_confirmation_mismatch',
        message: '현재 사용자명을 정확히 입력해 주세요.',
      });
    }
    if (username === profile.username) {
      throw new BadRequestException({ code: 'wiki_username_unchanged', message: '새 사용자명이 현재 사용자명과 같습니다.' });
    }
    const group = await this.resolveActiveGroup(session.userId);
    await this.reauthenticate(group, session, input.password);

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const confirmedGroup = await readCanonicalAccountGroup(tx, session.userId);
      if (!sameScope(group, confirmedGroup)) {
        throw new ConflictException({ code: 'wiki_username_account_scope_changed', message: '계정 연결 상태가 변경되었습니다. 다시 시도해 주세요.' });
      }
      const activeCount = await tx.account.count({
        where: { id: { in: [...confirmedGroup.accountIds] }, lifecycleStatus: 'active' },
      });
      if (activeCount !== confirmedGroup.accountIds.length || !profile.accountId || !confirmedGroup.accountIds.includes(profile.accountId)) {
        throw new ConflictException({ code: 'wiki_username_account_inactive', message: '현재 계정 상태에서는 사용자명을 변경할 수 없습니다.' });
      }

      await tx.$queryRaw<Array<{ id: bigint }>>`SELECT id FROM users WHERE id = ${profile.id} FOR UPDATE`;
      const current = await tx.wikiProfile.findUnique({ where: { id: profile.id } });
      if (!current || current.status !== 'active' || current.username !== profile.username) {
        throw new ConflictException({ code: 'wiki_username_profile_changed', message: '프로필이 변경되었습니다. 새로고침 후 다시 시도해 주세요.' });
      }
      this.assertCooldown(current.usernameChangedAt, now);

      const [takenProfile, takenAlias, namespace] = await Promise.all([
        tx.wikiProfile.findUnique({ where: { username }, select: { id: true } }),
        tx.wikiUsernameAlias.findUnique({ where: { oldUsername: username }, select: { profileId: true } }),
        tx.wikiNamespace.findUnique({ where: { code: 'user' } }),
      ]);
      if (takenProfile || takenAlias) {
        throw new ConflictException({ code: 'wiki_username_taken', message: '이미 사용 중이거나 이전에 사용된 사용자명입니다.' });
      }
      if (!namespace) throw new NotFoundException('User wiki namespace not found.');
      await tx.$queryRaw<Array<{ id: number }>>`SELECT id FROM namespaces WHERE id = ${namespace.id} FOR UPDATE`;

      const oldUsername = current.username;
      const pageCandidates = await tx.wikiPage.findMany({
        where: {
          namespaceId: namespace.id,
          ownerProfileId: current.id,
          OR: [{ localPath: oldUsername }, { localPath: { startsWith: `${oldUsername}/` } }],
        },
        orderBy: { id: 'asc' },
      });
      const pages = pageCandidates.filter((page) =>
        page.localPath === oldUsername || page.localPath.startsWith(`${oldUsername}/`)
      );
      for (const page of pages) {
        await tx.$queryRaw<Array<{ id: bigint }>>`SELECT id FROM pages WHERE id = ${page.id} FOR UPDATE`;
      }

      const pendingRequestCandidates = await tx.wikiEditRequest.findMany({
        where: {
          requestKind: 'create',
          pageId: null,
          targetNamespaceId: namespace.id,
          targetNamespaceCode: 'user',
          targetOwnerProfileId: current.id,
          status: { in: ['pending', 'reviewing', 'stale'] },
          OR: [{ targetTitle: oldUsername }, { targetTitle: { startsWith: `${oldUsername}/` } }],
        },
        orderBy: { id: 'asc' },
      });
      const pendingRequests = pendingRequestCandidates.filter((request) =>
        request.targetTitle === oldUsername || request.targetTitle?.startsWith(`${oldUsername}/`) === true
      );
      for (const request of pendingRequests) {
        await tx.$queryRaw<Array<{ id: bigint }>>`SELECT id FROM wiki_edit_requests WHERE id = ${request.id} FOR UPDATE`;
        if (!request.targetTitle || !request.targetSlug) {
          throw new ConflictException({ code: 'wiki_username_edit_request_invalid', message: '사용자 문서 편집 요청의 대상 경로가 올바르지 않습니다.' });
        }
        const { targetTitle, targetSlug, targetDisplayTitle } = renameUsernameTargetFields(
          {
            targetTitle: request.targetTitle,
            targetSlug: request.targetSlug,
            targetDisplayTitle: request.targetDisplayTitle,
          },
          oldUsername,
          username,
        );
        if (targetTitle.length > 255 || targetSlug.length > 255 || (targetDisplayTitle?.length ?? 0) > 255) {
          throw new ConflictException({ code: 'wiki_username_edit_request_path_too_long', message: '변경 후 편집 요청 경로가 너무 깁니다.' });
        }
        await tx.wikiEditRequest.update({
          where: { id: request.id },
          data: { targetTitle, targetSlug, targetDisplayTitle, updatedAt: now },
        });
      }

      const finalPages = pages.map((page) => this.renamedPage(page, oldUsername, username));
      const nonce = randomUUID().replaceAll('-', '');
      for (let index = 0; index < pages.length; index += 1) {
        const sentinel = `__username_rename_${nonce}_${index}`;
        await tx.wikiPage.update({
          where: { id: pages[index]!.id },
          data: { localPath: sentinel, slug: sentinel, title: sentinel, displayTitle: sentinel, updatedAt: now },
        });
      }
      const updatedPages: WikiPage[] = [];
      for (const page of finalPages) {
        updatedPages.push(await tx.wikiPage.update({
          where: { id: page.id },
          data: {
            localPath: page.localPath,
            slug: page.slug,
            title: page.title,
            displayTitle: page.displayTitle,
            updatedAt: now,
          },
        }));
      }

      await tx.wikiUsernameAlias.create({ data: { oldUsername, profileId: current.id, createdAt: now } });
      const updatedProfile = await tx.wikiProfile.update({
        where: { id: current.id },
        data: { username, usernameChangedAt: now, updatedAt: now },
      });

      if (pages.length > 0) {
        await Promise.all([
          tx.wikiPageRenderCache.deleteMany({ where: { pageId: { in: pages.map((page) => page.id) } } }),
          tx.wikiSearchDocument.deleteMany({ where: { pageId: { in: pages.map((page) => page.id) } } }),
        ]);
      }
      const revisionIds = updatedPages.flatMap((page) => page.currentRevisionId ? [page.currentRevisionId] : []);
      const revisions = revisionIds.length > 0
        ? await tx.wikiPageRevision.findMany({ where: { id: { in: revisionIds } } })
        : [];
      const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
      for (const page of updatedPages) {
        const revision = page.currentRevisionId ? revisionById.get(page.currentRevisionId) : undefined;
        if (revision?.pageId === page.id) await this.rebuildCurrentArtifacts(tx, page, revision);
      }

      if (updatedPages.length > 0) {
        await tx.wikiRecentChange.createMany({
          data: updatedPages.map((page) => ({
            pageId: page.id,
            revisionId: page.currentRevisionId,
            actorId: current.id,
            changeType: 'move',
            title: page.title,
            namespaceCode: 'user',
            summary: `${oldUsername} -> ${username} | 사용자명 변경`.slice(0, 255),
            isMinor: false,
            createdAt: now,
          })),
        });
      }
      await tx.auditEvent.create({
        data: {
          category: 'wiki',
          action: 'wiki.profile.rename',
          severity: 'info',
          actorAccountId: session.userId,
          actorProfileId: current.id,
          subjectType: 'wiki_profile',
          subjectId: current.id.toString(),
          metadata: { previousUsername: oldUsername, username, movedDocumentCount: updatedPages.length },
          createdAt: now,
        },
      });

      const documentCount = await tx.wikiPage.count({
        where: { namespaceId: namespace.id, ownerProfileId: current.id, status: { not: 'deleted' } },
      });
      return {
        ...this.state(updatedProfile, documentCount),
        previousUsername: oldUsername,
        movedDocumentCount: updatedPages.length,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        throw new ConflictException({ code: 'wiki_username_taken', message: '이미 사용 중이거나 이전에 사용된 사용자명입니다.' });
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') {
        throw new ConflictException({ code: 'wiki_username_concurrency_conflict', message: '동시에 변경된 데이터가 있습니다. 다시 시도해 주세요.' });
      }
      throw error;
    });
  }

  private state(profile: { username: string; usernameChangedAt: Date | null }, documentCount: number): WikiUsernameStateResponse {
    const next = profile.usernameChangedAt ? new Date(profile.usernameChangedAt.getTime() + COOLDOWN_MS) : null;
    return {
      username: profile.username,
      changedAt: profile.usernameChangedAt?.toISOString() ?? null,
      nextChangeAt: next?.toISOString() ?? null,
      canChange: !next || next.getTime() <= Date.now(),
      cooldownDays: COOLDOWN_DAYS,
      documentCount,
    };
  }

  private validateUsername(value?: string): string {
    if (typeof value !== 'string' || value.normalize('NFKC') !== value || !USERNAME_PATTERN.test(value)) {
      throw new BadRequestException({ code: 'wiki_username_invalid', message: '사용자명은 한글, 영문, 숫자, 밑줄, 하이픈으로 2~32자여야 합니다.' });
    }
    if (/^[_-]|[_-]$/u.test(value) || RESERVED_USERNAMES.has(value.toLocaleLowerCase('en-US'))) {
      throw new BadRequestException({ code: 'wiki_username_reserved', message: '사용할 수 없는 사용자명입니다.' });
    }
    return value;
  }

  private assertCooldown(changedAt: Date | null, now: Date): void {
    if (!changedAt || changedAt.getTime() + COOLDOWN_MS <= now.getTime()) return;
    throw new ConflictException({
      code: 'wiki_username_cooldown',
      message: '사용자명은 30일에 한 번만 변경할 수 있습니다.',
      nextChangeAt: new Date(changedAt.getTime() + COOLDOWN_MS).toISOString(),
    });
  }

  private async resolveActiveGroup(accountId: string): Promise<CanonicalAccountGroup> {
    const group = await readCanonicalAccountGroup(this.prisma, accountId);
    const active = await this.prisma.account.count({
      where: { id: { in: [...group.accountIds] }, lifecycleStatus: 'active' },
    });
    if (active !== group.accountIds.length) {
      throw new ConflictException({ code: 'wiki_username_account_inactive', message: '현재 계정 상태에서는 사용자명을 변경할 수 없습니다.' });
    }
    return group;
  }

  private async reauthenticate(group: CanonicalAccountGroup, session: SessionPayload, password?: string): Promise<void> {
    const accounts = await this.prisma.account.findMany({
      where: { id: { in: [...group.accountIds] } },
      select: { passwordHash: true },
    });
    const hashes = accounts.flatMap((account) => account.passwordHash ? [account.passwordHash] : []);
    if (hashes.length > 0) {
      if (!password) throw new ForbiddenException({ code: 'wiki_username_reauth_required', message: '현재 비밀번호를 입력해 주세요.' });
      for (const hash of hashes) if (await verify(hash, password)) return;
      throw new UnauthorizedException({ code: 'wiki_username_password_invalid', message: '현재 비밀번호가 올바르지 않습니다.' });
    }
    const authenticatedAt = Date.parse(session.authenticatedAt);
    const now = Date.now();
    if (Number.isFinite(authenticatedAt) && authenticatedAt <= now && now - authenticatedAt <= RECENT_OAUTH_MS) return;
    throw new ForbiddenException({ code: 'wiki_username_reauth_required', message: '다시 로그인한 뒤 15분 안에 사용자명을 변경해 주세요.' });
  }

  private renamedPage(page: WikiPage, previous: string, next: string): WikiPage {
    const renamed = {
      ...page,
      localPath: replaceRoot(page.localPath, previous, next),
      slug: replaceRoot(page.slug, previous, next),
      title: replaceRoot(page.title, previous, next),
      displayTitle: replaceRoot(page.displayTitle, previous, next),
    };
    if (renamed.localPath.length > 500 || renamed.slug.length > 255 || renamed.title.length > 255 || renamed.displayTitle.length > 255) {
      throw new BadRequestException({ code: 'wiki_username_document_path_too_long', message: '변경 후 사용자 문서 경로가 너무 깁니다.' });
    }
    return renamed;
  }

  private async rebuildCurrentArtifacts(tx: Prisma.TransactionClient, page: WikiPage, revision: WikiPageRevision): Promise<void> {
    const parsed = parseMarkup(revision.contentRaw, { linkResolution: wikiLinkResolutionContext('user', page.localPath) });
    await this.wikiLinks.replaceForRevision(
      tx,
      page.id,
      revision.id,
      parsed.links,
      parsed.categories,
      parsed.includes,
      {
        contentSize: revision.contentSize,
        contentRaw: revision.contentRaw,
        fileNames: [...collectWikiFileNames(parsed.ast)],
        redirectTarget: parsed.redirectTarget,
      },
    );
  }
}

function replaceRoot(value: string, previous: string, next: string): string {
  if (value === previous) return next;
  return value.startsWith(`${previous}/`) ? `${next}${value.slice(previous.length)}` : value;
}

export function renameUsernameTargetFields(
  target: { readonly targetTitle: string; readonly targetSlug: string; readonly targetDisplayTitle: string | null },
  previous: string,
  next: string,
) {
  return {
    targetTitle: replaceRoot(target.targetTitle, previous, next),
    targetSlug: replaceRoot(target.targetSlug, previous, next),
    targetDisplayTitle: target.targetDisplayTitle ? replaceRoot(target.targetDisplayTitle, previous, next) : null,
  };
}

function sameScope(left: CanonicalAccountGroup, right: CanonicalAccountGroup): boolean {
  return left.canonicalAccountId === right.canonicalAccountId
    && left.accountIds.length === right.accountIds.length
    && [...left.accountIds].sort().every((id, index) => id === [...right.accountIds].sort()[index]);
}
