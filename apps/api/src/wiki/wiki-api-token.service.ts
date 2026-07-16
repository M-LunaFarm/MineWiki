import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import { SessionService, type SessionPayload } from '../session/session.service';

export const WIKI_API_SCOPES = ['wiki:read', 'wiki:create', 'wiki:edit'] as const;
export type WikiApiScope = (typeof WIKI_API_SCOPES)[number];

const createTokenSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(WIKI_API_SCOPES)).min(1).max(WIKI_API_SCOPES.length),
  spaceId: z.string().trim().regex(/^\d+$/).optional().nullable(),
  expiresInDays: z.number().int().min(1).max(365).default(30),
}).strict();

const TOKEN_PATTERN = /^mwk_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/;
const RECENT_AUTH_MS = 15 * 60 * 1000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface WikiApiTokenView {
  readonly id: string;
  readonly name: string;
  readonly tokenPrefix: string;
  readonly scopes: readonly WikiApiScope[];
  readonly space: { readonly id: string; readonly name: string; readonly path: string } | null;
  readonly status: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
}

export interface WikiApiTokenCreated extends WikiApiTokenView {
  readonly token: string;
}

export interface WikiApiSpaceView {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly type: string;
}

export interface AuthenticatedWikiApiToken {
  readonly id: string;
  readonly accountId: string;
  readonly scopes: readonly WikiApiScope[];
  readonly spaceId: string | null;
  readonly session: SessionPayload;
}

@Injectable()
export class WikiApiTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly events: BusinessEventService,
  ) {}

  async create(session: SessionPayload, rawBody: unknown): Promise<WikiApiTokenCreated> {
    this.assertRecentAuthentication(session);
    const parsed = createTokenSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException('토큰 이름, 권한, 만료일 또는 Wiki 공간이 올바르지 않습니다.');
    }
    const input = parsed.data;
    const accountGroup = await this.resolveActiveAccountGroup(session.userId);
    const scopes = [...new Set(input.scopes)];
    const spaceId = input.spaceId ? BigInt(input.spaceId) : null;
    const space = spaceId
      ? await this.prisma.wikiSpace.findFirst({
          where: { id: spaceId, status: 'active' },
          select: { id: true, name: true, rootPath: true },
        })
      : null;
    if (spaceId && !space) throw new NotFoundException('사용 가능한 Wiki 공간을 찾을 수 없습니다.');

    const prefix = randomBytes(6).toString('hex');
    const token = `mwk_${prefix}_${randomBytes(32).toString('base64url')}`;
    const created = await this.prisma.wikiApiToken.create({
      data: {
        accountId: accountGroup.canonicalAccountId,
        name: input.name,
        tokenPrefix: prefix,
        secretHash: hashValue(token),
        scopes,
        spaceId,
        expiresAt: new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000),
      },
      include: { space: { select: { id: true, name: true, rootPath: true } } },
    });
    await this.events.audit('wiki.api_token.created', {
      category: 'wiki',
      actorAccountId: accountGroup.canonicalAccountId,
      subjectType: 'wiki_api_token',
      subjectId: created.id,
      ipAddress: session.requestIp ?? null,
      metadata: { name: created.name, tokenPrefix: prefix, scopes, spaceId: spaceId?.toString() ?? null },
    });
    return { ...this.toView(created), token };
  }

  async list(accountId: string): Promise<WikiApiTokenView[]> {
    const accountGroup = await this.resolveActiveAccountGroup(accountId);
    const rows = await this.prisma.wikiApiToken.findMany({
      where: { accountId: { in: accountGroup.accountIds } },
      include: { space: { select: { id: true, name: true, rootPath: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((row) => this.toView(row));
  }

  async listSpaces(): Promise<WikiApiSpaceView[]> {
    const rows = await this.prisma.wikiSpace.findMany({
      where: { status: 'active' },
      select: { id: true, name: true, rootPath: true, spaceType: true },
      orderBy: [{ spaceType: 'asc' }, { name: 'asc' }],
      take: 200,
    });
    return rows.map((row) => ({
      id: row.id.toString(),
      name: row.name,
      path: row.rootPath,
      type: row.spaceType,
    }));
  }

  async revoke(session: SessionPayload, tokenId: string): Promise<{ readonly revoked: true }> {
    if (!/^[0-9a-f-]{36}$/i.test(tokenId)) throw new NotFoundException('토큰을 찾을 수 없습니다.');
    const accountGroup = await this.resolveActiveAccountGroup(session.userId);
    const revoked = await this.prisma.wikiApiToken.updateMany({
      where: { id: tokenId, accountId: { in: accountGroup.accountIds }, status: 'active' },
      data: { status: 'revoked', revokedAt: new Date() },
    });
    if (revoked.count !== 1) throw new NotFoundException('활성 토큰을 찾을 수 없습니다.');
    await this.events.audit('wiki.api_token.revoked', {
      category: 'wiki',
      actorAccountId: accountGroup.canonicalAccountId,
      subjectType: 'wiki_api_token',
      subjectId: tokenId,
      ipAddress: session.requestIp ?? null,
    });
    return { revoked: true };
  }

  async authenticate(rawToken: string, requestIp?: string | null): Promise<AuthenticatedWikiApiToken> {
    const match = TOKEN_PATTERN.exec(rawToken);
    if (!match) throw new UnauthorizedException('Wiki API 토큰이 올바르지 않습니다.');
    const token = await this.prisma.wikiApiToken.findUnique({
      where: { tokenPrefix: match[1]! },
      include: {
        account: { select: { id: true, canonicalAccountId: true, lifecycleStatus: true } },
        space: { select: { status: true } },
      },
    });
    const presentedHash = Buffer.from(hashValue(rawToken), 'hex');
    const storedHash = Buffer.from(token?.secretHash ?? '0'.repeat(64), 'hex');
    if (!timingSafeEqual(presentedHash, storedHash) || !token) {
      throw new UnauthorizedException('Wiki API 토큰이 올바르지 않습니다.');
    }
    if (token.status !== 'active' || token.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Wiki API 토큰이 만료되었거나 폐기되었습니다.');
    }
    if (token.spaceId && token.space?.status !== 'active') {
      throw new UnauthorizedException('이 토큰에 연결된 Wiki 공간이 더 이상 활성 상태가 아닙니다.');
    }
    const accountGroup = await this.resolveActiveAccountGroup(token.account.id);
    const canonicalAccountId = accountGroup.canonicalAccountId;
    const policyConsent = await this.sessions.getPolicyConsentStatus(canonicalAccountId);
    if (policyConsent.required) {
      throw new ForbiddenException({
        code: 'POLICY_CONSENT_REQUIRED',
        message: 'MineWiki에서 개정된 약관에 동의한 뒤 Wiki API를 사용해 주세요.',
      });
    }
    const scopes = parseScopes(token.scopes);
    if (scopes.length === 0) throw new ForbiddenException('Wiki API 토큰에 유효한 권한이 없습니다.');
    const now = new Date();
    if (!token.lastUsedAt || now.getTime() - token.lastUsedAt.getTime() >= 5 * 60 * 1000) {
      await this.prisma.wikiApiToken.updateMany({
        where: { id: token.id, status: 'active' },
        data: { lastUsedAt: now, lastUsedIp: requestIp?.slice(0, 64) || null },
      });
    }
    return {
      id: token.id,
      accountId: canonicalAccountId,
      scopes,
      spaceId: token.spaceId?.toString() ?? null,
      session: {
        sessionId: `wiki-api:${token.id}`,
        userId: canonicalAccountId,
        tokenVersion: 1,
        isElevated: false,
        authenticatedAt: '1970-01-01T00:00:00.000Z',
        authLevel: 'aal1',
        stepUpAt: null,
        stepUpExpiresAt: null,
        stepUpMethod: null,
        stepUpPurpose: null,
        permissions: [],
        groups: [],
        policyConsent,
        requestIp: requestIp ?? null,
      },
    };
  }

  assertScope(token: AuthenticatedWikiApiToken, scope: WikiApiScope): void {
    if (!token.scopes.includes(scope)) throw new ForbiddenException(`토큰에 ${scope} 권한이 없습니다.`);
  }

  async assertPageSpace(token: AuthenticatedWikiApiToken, pageId: string): Promise<void> {
    if (!token.spaceId) return;
    if (!/^\d+$/.test(pageId)) throw new NotFoundException('Wiki 문서를 찾을 수 없습니다.');
    const page = await this.prisma.wikiPage.findUnique({
      where: { id: BigInt(pageId) },
      select: { spaceId: true },
    });
    if (!page || page.spaceId.toString() !== token.spaceId) {
      throw new ForbiddenException('이 토큰은 선택한 서버 Wiki 밖에서 사용할 수 없습니다.');
    }
  }

  assertResponseSpace(token: AuthenticatedWikiApiToken, spaceId: string): void {
    if (token.spaceId && token.spaceId !== spaceId) {
      throw new ForbiddenException('이 토큰은 선택한 서버 Wiki 밖에서 사용할 수 없습니다.');
    }
  }

  assertCreateSpace(token: AuthenticatedWikiApiToken, requestedSpaceId?: string | null): void {
    if (token.spaceId && token.spaceId !== requestedSpaceId) {
      throw new ForbiddenException('공간 제한 토큰은 지정된 서버 Wiki에만 문서를 만들 수 있습니다.');
    }
  }

  async idempotent<T extends object>(input: {
    readonly tokenId: string;
    readonly key: string | undefined;
    readonly method: 'POST' | 'PATCH';
    readonly route: string;
    readonly body: unknown;
    readonly responseStatus: number;
    readonly action: () => Promise<T>;
  }): Promise<T> {
    const key = input.key?.trim();
    if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw new BadRequestException('Idempotency-Key 헤더를 8~128자의 안전한 값으로 보내 주세요.');
    }
    const keyHash = hashValue(key);
    const requestHash = hashValue(`${input.method}\n${input.route}\n${stableJson(input.body)}`);
    const now = new Date();
    await this.prisma.wikiApiIdempotencyRecord.deleteMany({
      where: { status: 'completed', expiresAt: { lte: now } },
    });
    try {
      await this.prisma.wikiApiIdempotencyRecord.create({
        data: {
          tokenId: input.tokenId,
          keyHash,
          requestHash,
          method: input.method,
          route: input.route,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
      const existingByKey = await this.prisma.wikiApiIdempotencyRecord.findUnique({
        where: { tokenId_keyHash: { tokenId: input.tokenId, keyHash } },
      });
      const existing = existingByKey ?? await this.prisma.wikiApiIdempotencyRecord.findFirst({
        where: { tokenId: input.tokenId, requestHash, route: input.route },
      });
      if (!existing || existing.requestHash !== requestHash || existing.method !== input.method || existing.route !== input.route) {
        throw new ConflictException('같은 Idempotency-Key가 다른 요청에 사용되었습니다.');
      }
      if (existing.status === 'completed' && existing.responseBody) return existing.responseBody as T;
      if (existing.status === 'indeterminate' || existing.expiresAt.getTime() <= now.getTime()) {
        await this.prisma.wikiApiIdempotencyRecord.updateMany({
          where: { id: existing.id, status: 'processing' },
          data: { status: 'indeterminate', completedAt: now },
        });
        throw new ConflictException({
          code: 'IDEMPOTENCY_RESULT_UNKNOWN',
          message: '이 요청은 처리 결과를 확정할 수 없습니다. 같은 변경을 다시 보내지 말고 먼저 문서의 현재 리비전을 확인해 주세요.',
        });
      }
      throw new ConflictException('같은 요청이 처리 중입니다. 잠시 후 결과를 확인해 주세요.');
    }
    let response: T;
    try {
      response = await input.action();
    } catch (error) {
      await this.prisma.wikiApiIdempotencyRecord.deleteMany({
        where: { tokenId: input.tokenId, keyHash, status: 'processing' },
      });
      throw error;
    }
    try {
      const responseBody = JSON.parse(JSON.stringify(response)) as Prisma.InputJsonValue;
      await this.prisma.wikiApiIdempotencyRecord.update({
        where: { tokenId_keyHash: { tokenId: input.tokenId, keyHash } },
        data: {
          status: 'completed',
          responseStatus: input.responseStatus,
          responseBody,
          completedAt: new Date(),
        },
      });
      return response;
    } catch (error) {
      await this.prisma.wikiApiIdempotencyRecord.updateMany({
        where: { tokenId: input.tokenId, keyHash, status: 'processing' },
        data: { status: 'indeterminate', completedAt: new Date() },
      }).catch(() => undefined);
      throw new ConflictException({
        code: 'IDEMPOTENCY_RESULT_UNAVAILABLE',
        message: '요청은 처리되었지만 재시도 결과를 저장하지 못했습니다. 같은 키로 다시 변경하지 말고 문서 상태를 확인해 주세요.',
        cause: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private assertRecentAuthentication(session: SessionPayload): void {
    const authenticatedAt = Date.parse(session.authenticatedAt);
    if (session.authLevel !== 'aal2' && (!Number.isFinite(authenticatedAt) || Date.now() - authenticatedAt > RECENT_AUTH_MS)) {
      throw new ForbiddenException('보안을 위해 다시 로그인한 뒤 15분 안에 API 토큰을 만들어 주세요.');
    }
  }

  private async resolveActiveAccountGroup(seedAccountId: string): Promise<{
    readonly canonicalAccountId: string;
    readonly accountIds: string[];
  }> {
    const seed = await this.prisma.account.findUnique({
      where: { id: seedAccountId },
      select: { id: true, canonicalAccountId: true, lifecycleStatus: true },
    });
    if (!seed || seed.lifecycleStatus !== 'active') {
      throw new UnauthorizedException('토큰 소유 계정이 활성 상태가 아닙니다.');
    }
    const canonicalAccountId = seed.canonicalAccountId ?? seed.id;
    const accounts = await this.prisma.account.findMany({
      where: { OR: [{ id: canonicalAccountId }, { canonicalAccountId }] },
      select: { id: true, lifecycleStatus: true },
    });
    if (
      !accounts.some((account) => account.id === canonicalAccountId) ||
      accounts.some((account) => account.lifecycleStatus !== 'active')
    ) {
      throw new UnauthorizedException('토큰 소유 계정이 활성 상태가 아닙니다.');
    }
    return { canonicalAccountId, accountIds: accounts.map((account) => account.id) };
  }

  private toView(row: {
    id: string; name: string; tokenPrefix: string; scopes: Prisma.JsonValue; status: string;
    expiresAt: Date; lastUsedAt: Date | null; createdAt: Date;
    space: { id: bigint; name: string; rootPath: string } | null;
  }): WikiApiTokenView {
    return {
      id: row.id,
      name: row.name,
      tokenPrefix: row.tokenPrefix,
      scopes: parseScopes(row.scopes),
      space: row.space ? { id: row.space.id.toString(), name: row.space.name, path: row.space.rootPath } : null,
      status: row.status === 'active' && row.expiresAt.getTime() <= Date.now() ? 'expired' : row.status,
      expiresAt: row.expiresAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

function parseScopes(value: Prisma.JsonValue): WikiApiScope[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((scope): scope is WikiApiScope =>
    typeof scope === 'string' && (WIKI_API_SCOPES as readonly string[]).includes(scope),
  ))];
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}
