import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve4, resolve6, resolveCname, resolveTxt } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { parse as parseDomain } from 'tldts';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { writeAuditEvent } from '../events/audit-event-writer';
import { hasCanonicalPublicServerWikiParent } from './server-wiki-public-readiness';

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = 'minewiki-verification=';
const DOMAIN_STATUS = ['pending', 'verified', 'provisioning', 'active', 'disabled'] as const;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RECHECK_RETRY_MS = 15 * 60 * 1000;
const ROUTE_FRESHNESS_MS = 48 * 60 * 60 * 1000;
const FAILURE_DISABLE_THRESHOLD = 3;
const RESERVED_SUFFIXES = ['minewiki.kr'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ServerWikiDomainDnsResolver {
  resolveTxt(hostname: string): Promise<readonly (readonly string[])[]>;
  resolveCname(hostname: string): Promise<readonly string[]>;
  resolve4(hostname: string): Promise<readonly string[]>;
  resolve6(hostname: string): Promise<readonly string[]>;
}

export interface ServerWikiDomainResponse {
  readonly hostname: string;
  readonly status: (typeof DOMAIN_STATUS)[number];
  readonly version: number;
  readonly challenge: {
    readonly name: string;
    readonly value: string | null;
    readonly expiresAt: string;
  };
  readonly routing: {
    readonly type: 'CNAME';
    readonly name: string;
    readonly value: string;
  };
  readonly verifiedAt: string | null;
  readonly activatedAt: string | null;
  readonly tlsReadyAt: string | null;
  readonly lastCheckedAt: string | null;
  readonly nextCheckAt: string | null;
  readonly consecutiveFailures: number;
}

@Injectable()
export class ServerWikiDomainService {
  private readonly dns: ServerWikiDomainDnsResolver;
  private readonly routingTarget: string;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() dns?: ServerWikiDomainDnsResolver,
  ) {
    this.dns = dns ?? { resolveTxt, resolveCname, resolve4, resolve6 };
    this.routingTarget = normalizeRoutingTarget(process.env.SERVER_WIKI_DOMAIN_TARGET ?? 'domains.minewiki.kr');
  }

  async get(serverIdInput: string): Promise<ServerWikiDomainResponse | null> {
    const context = await this.serverWikiContext(serverIdInput);
    const domain = await this.prisma.serverWikiDomain.findUnique({ where: { serverWikiId: context.serverWikiId } });
    return domain ? response(domain, this.routingTarget, null) : null;
  }

  async configure(
    serverIdInput: string,
    hostnameInput: string,
    expectedVersion: number,
    actorAccountId: string,
  ): Promise<ServerWikiDomainResponse> {
    const serverId = parseServerId(serverIdInput);
    const hostname = normalizeCustomHostname(hostnameInput);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MS);
    try {
      const domain = await this.prisma.$transaction(async (tx) => {
        const context = await this.serverWikiContext(serverId, tx, true);
        const current = await tx.serverWikiDomain.findUnique({ where: { serverWikiId: context.serverWikiId } });
        if (!current) {
          if (expectedVersion !== 0) throw staleDomainVersion();
          const created = await tx.serverWikiDomain.create({
            data: {
              serverWikiId: context.serverWikiId,
              spaceId: context.spaceId,
              hostname,
              status: 'pending',
              verificationTokenHash: tokenHash,
              verificationExpiresAt: expiresAt,
              version: 1,
              createdBy: actorAccountId,
              createdAt: now,
              updatedAt: now,
            },
          });
          await this.audit(tx, 'server.wiki_domain.configure', actorAccountId, context.serverWikiId, {
            hostname, previousHostname: null, version: created.version,
          }, now);
          return created;
        }
        if (current.version !== expectedVersion) throw staleDomainVersion();
        const updated = await tx.serverWikiDomain.updateMany({
          where: { id: current.id, serverWikiId: context.serverWikiId, spaceId: context.spaceId, version: expectedVersion },
          data: {
            hostname,
            status: 'pending',
            verificationTokenHash: tokenHash,
            verificationExpiresAt: expiresAt,
            version: { increment: 1 },
            verifiedAt: null,
              activatedAt: null,
              tlsReadyAt: null,
              disabledAt: null,
              lastCheckedAt: null,
              nextCheckAt: null,
              consecutiveFailures: 0,
            updatedAt: now,
          },
        });
        if (updated.count !== 1) throw staleDomainVersion();
        const saved = await tx.serverWikiDomain.findUniqueOrThrow({ where: { id: current.id } });
        await this.audit(tx, 'server.wiki_domain.configure', actorAccountId, context.serverWikiId, {
          hostname, previousHostname: current.hostname, version: saved.version,
        }, now);
        return saved;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
      return response(domain, this.routingTarget, token);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('이미 다른 서버 위키에서 사용 중인 도메인입니다.');
      }
      throw error;
    }
  }

  async verify(
    serverIdInput: string,
    expectedVersion: number,
    actorAccountId: string,
  ): Promise<ServerWikiDomainResponse> {
    const serverId = parseServerId(serverIdInput);
    const context = await this.serverWikiContext(serverId);
    const domain = await this.prisma.serverWikiDomain.findUnique({ where: { serverWikiId: context.serverWikiId } });
    if (!domain || domain.spaceId !== context.spaceId || domain.status === 'disabled') throw domainNotFound();
    if (domain.version !== expectedVersion) throw staleDomainVersion();
    const now = new Date();
    if (domain.verificationExpiresAt.getTime() <= now.getTime()) {
      throw new ConflictException('도메인 확인 값이 만료되었습니다. 도메인을 다시 저장해 새 값을 발급하세요.');
    }
    const [ownsDomain, routesToMineWiki] = await Promise.all([
      this.hasOwnershipProof(domain.hostname, domain.verificationTokenHash),
      this.routesToMineWiki(domain.hostname),
    ]);
    if (!ownsDomain || !routesToMineWiki) {
      await this.prisma.serverWikiDomain.updateMany({
        where: { id: domain.id, version: expectedVersion },
        data: { lastCheckedAt: now, updatedAt: now },
      });
      throw new ConflictException({
        code: 'SERVER_WIKI_DOMAIN_DNS_NOT_READY',
        ownershipVerified: ownsDomain,
        routingVerified: routesToMineWiki,
      });
    }
    const saved = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.serverWikiDomain.updateMany({
        where: {
          id: domain.id,
          serverWikiId: context.serverWikiId,
          spaceId: context.spaceId,
          version: expectedVersion,
          status: { in: ['pending', 'active'] },
        },
        data: {
          status: 'verified',
          version: { increment: 1 },
          verifiedAt: now,
          activatedAt: null,
          tlsReadyAt: null,
          lastCheckedAt: now,
          nextCheckAt: new Date(now.getTime() + RECHECK_INTERVAL_MS),
          consecutiveFailures: 0,
          disabledAt: null,
          updatedAt: now,
        },
      });
      if (updated.count !== 1) throw staleDomainVersion();
      const active = await tx.serverWikiDomain.findUniqueOrThrow({ where: { id: domain.id } });
      await this.audit(tx, 'server.wiki_domain.verify', actorAccountId, context.serverWikiId, {
        hostname: active.hostname, version: active.version,
      }, now);
      return active;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
    return response(saved, this.routingTarget, null);
  }

  async disable(
    serverIdInput: string,
    expectedVersion: number,
    reason: string,
    actorAccountId: string,
  ): Promise<ServerWikiDomainResponse> {
    const serverId = parseServerId(serverIdInput);
    const normalizedReason = reason.trim();
    if (normalizedReason.length < 5 || normalizedReason.length > 500) {
      throw new BadRequestException('비활성화 사유는 5~500자로 입력하세요.');
    }
    const now = new Date();
    const saved = await this.prisma.$transaction(async (tx) => {
      const context = await this.serverWikiContext(serverId, tx, true);
      const domain = await tx.serverWikiDomain.findUnique({ where: { serverWikiId: context.serverWikiId } });
      if (!domain || domain.spaceId !== context.spaceId) throw domainNotFound();
      if (domain.version !== expectedVersion) throw staleDomainVersion();
      const updated = await tx.serverWikiDomain.updateMany({
        where: { id: domain.id, version: expectedVersion, status: { not: 'disabled' } },
        data: { status: 'disabled', version: { increment: 1 }, disabledAt: now, updatedAt: now },
      });
      if (updated.count !== 1) throw staleDomainVersion();
      const disabled = await tx.serverWikiDomain.findUniqueOrThrow({ where: { id: domain.id } });
      await this.audit(tx, 'server.wiki_domain.disable', actorAccountId, context.serverWikiId, {
        hostname: disabled.hostname, version: disabled.version, reason: normalizedReason,
      }, now);
      return disabled;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
    return response(saved, this.routingTarget, null);
  }

  async resolveActiveHost(hostnameInput: string): Promise<{ readonly hostname: string; readonly siteSlug: string; readonly bindingVersion: number }> {
    const hostname = normalizeCustomHostname(hostnameInput);
    const domain = await this.prisma.serverWikiDomain.findUnique({
      where: { hostname },
      include: {
        serverWiki: {
          include: {
            space: true,
          },
        },
      },
    });
    const freshnessFloor = new Date(Date.now() - ROUTE_FRESHNESS_MS);
    if (!domain || domain.status !== 'active' || !domain.tlsReadyAt || !domain.lastCheckedAt || domain.lastCheckedAt < freshnessFloor) {
      throw domainNotFound();
    }
    const wiki = domain.serverWiki;
    if (wiki.spaceId !== domain.spaceId || !wiki.voteServerId || !wiki.siteSlug || !wiki.publishedReleaseId) throw domainNotFound();
    const server = await this.prisma.server.findUnique({ where: { id: wiki.voteServerId } });
    if (!hasCanonicalPublicServerWikiParent({ space: wiki.space, wiki, server })) throw domainNotFound();
    return { hostname: domain.hostname, siteSlug: wiki.siteSlug, bindingVersion: domain.version };
  }

  async isTlsAllowed(hostnameInput: string): Promise<boolean> {
    const hostname = normalizeCustomHostname(hostnameInput);
    const domain = await this.prisma.serverWikiDomain.findUnique({ where: { hostname } });
    if (!domain || !['verified', 'provisioning', 'active'].includes(domain.status) || !domain.verifiedAt) return false;
    const wiki = await this.prisma.serverWiki.findUnique({
      where: { id: domain.serverWikiId },
      include: { space: true },
    });
    if (!wiki || wiki.spaceId !== domain.spaceId || !wiki.voteServerId || !wiki.publishedReleaseId) return false;
    const server = await this.prisma.server.findUnique({ where: { id: wiki.voteServerId } });
    return hasCanonicalPublicServerWikiParent({ space: wiki.space, wiki, server });
  }

  async markProvisioning(hostnameInput: string): Promise<void> {
    const hostname = normalizeCustomHostname(hostnameInput);
    await this.prisma.serverWikiDomain.updateMany({
      where: { hostname, status: 'verified' },
      data: { status: 'provisioning', updatedAt: new Date() },
    });
  }

  async activateProvisioned(hostnameInput: string, expectedVersion: number): Promise<ServerWikiDomainResponse> {
    const hostname = normalizeCustomHostname(hostnameInput);
    const now = new Date();
    const current = await this.prisma.serverWikiDomain.findUnique({ where: { hostname } });
    if (!current || !['verified', 'provisioning', 'active'].includes(current.status)) throw domainNotFound();
    if (current.version !== expectedVersion) throw staleDomainVersion();
    const saved = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.serverWikiDomain.updateMany({
        where: { id: current.id, version: expectedVersion, status: { in: ['verified', 'provisioning', 'active'] } },
        data: {
          status: 'active',
          version: { increment: 1 },
          activatedAt: current.activatedAt ?? now,
          tlsReadyAt: now,
          lastCheckedAt: now,
          nextCheckAt: new Date(now.getTime() + RECHECK_INTERVAL_MS),
          consecutiveFailures: 0,
          disabledAt: null,
          updatedAt: now,
        },
      });
      if (updated.count !== 1) throw staleDomainVersion();
      const active = await tx.serverWikiDomain.findUniqueOrThrow({ where: { id: current.id } });
      await writeAuditEvent(tx, 'server.wiki_domain.activate', {
        category: 'server', subjectType: 'server_wiki', subjectId: current.serverWikiId,
        metadata: { hostname, version: active.version, provisioner: 'nginx-certbot' }, createdAt: now,
      });
      return active;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 });
    return response(saved, this.routingTarget, null);
  }

  async listProvisioningDomains(cursorInput?: string, limitInput = 100): Promise<{
    readonly items: ReadonlyArray<{ readonly hostname: string; readonly status: string; readonly version: number }>;
    readonly nextCursor: string | null;
  }> {
    const limit = Number.isFinite(limitInput) ? Math.max(1, Math.min(500, Math.trunc(limitInput))) : 100;
    let cursor: bigint | undefined;
    if (cursorInput?.trim()) {
      try { cursor = BigInt(cursorInput); } catch { throw new BadRequestException('도메인 cursor가 올바르지 않습니다.'); }
      if (cursor <= 0n) throw new BadRequestException('도메인 cursor가 올바르지 않습니다.');
    }
    const rows = await this.prisma.serverWikiDomain.findMany({
      where: cursor ? { id: { gt: cursor } } : undefined,
      orderBy: { id: 'asc' },
      take: limit + 1,
      select: { id: true, hostname: true, status: true, version: true },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(({ hostname, status, version }) => ({ hostname, status, version })),
      nextCursor: rows.length > limit ? page.at(-1)?.id.toString() ?? null : null,
    };
  }

  async revalidateDue(limit = 50): Promise<{ readonly checked: number; readonly disabled: number }> {
    const now = new Date();
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 50;
    const due = await this.prisma.serverWikiDomain.findMany({
      where: { status: { in: ['verified', 'provisioning', 'active'] }, nextCheckAt: { lte: now } },
      orderBy: { nextCheckAt: 'asc' },
      take: safeLimit,
    });
    let disabled = 0;
    for (const domain of due) {
      const [ownsDomain, routesToMineWiki] = await Promise.all([
        this.hasOwnershipProof(domain.hostname, domain.verificationTokenHash),
        this.routesToMineWiki(domain.hostname),
      ]);
      if (ownsDomain && routesToMineWiki) {
        await this.prisma.serverWikiDomain.updateMany({
          where: { id: domain.id, version: domain.version },
          data: { lastCheckedAt: now, nextCheckAt: new Date(now.getTime() + RECHECK_INTERVAL_MS), consecutiveFailures: 0, updatedAt: now },
        });
        continue;
      }
      const failures = domain.consecutiveFailures + 1;
      const shouldDisable = failures >= FAILURE_DISABLE_THRESHOLD;
      const result = await this.prisma.serverWikiDomain.updateMany({
        where: { id: domain.id, version: domain.version },
        data: {
          status: shouldDisable ? 'disabled' : domain.status,
          consecutiveFailures: failures,
          lastCheckedAt: now,
          nextCheckAt: shouldDisable ? null : new Date(now.getTime() + RECHECK_RETRY_MS),
          disabledAt: shouldDisable ? now : domain.disabledAt,
          updatedAt: now,
        },
      });
      if (shouldDisable && result.count === 1) disabled += 1;
    }
    return { checked: due.length, disabled };
  }

  private async hasOwnershipProof(hostname: string, expectedHash: string): Promise<boolean> {
    try {
      const records = await this.dns.resolveTxt(challengeName(hostname));
      return records
        .map((parts) => parts.join('').trim())
        .filter((value) => value.startsWith(TOKEN_PREFIX))
        .some((value) => safeHashEqual(hashToken(value.slice(TOKEN_PREFIX.length)), expectedHash));
    } catch {
      return false;
    }
  }

  private async routesToMineWiki(hostname: string): Promise<boolean> {
    try {
      const aliases = await this.dns.resolveCname(hostname);
      if (aliases.some((alias) => normalizeDnsName(alias) === this.routingTarget)) return true;
    } catch {
      // A/AAAA records are checked below for providers that flatten CNAMEs.
    }
    try {
      const [host4, host6, target4, target6] = await Promise.all([
        this.dns.resolve4(hostname).catch(() => []),
        this.dns.resolve6(hostname).catch(() => []),
        this.dns.resolve4(this.routingTarget).catch(() => []),
        this.dns.resolve6(this.routingTarget).catch(() => []),
      ]);
      const targets = new Set([...target4, ...target6]);
      return targets.size > 0 && [...host4, ...host6].some((address) => targets.has(address));
    } catch {
      return false;
    }
  }

  private async serverWikiContext(
    serverIdInput: string,
    store: Prisma.TransactionClient | PrismaService = this.prisma,
    lock = false,
  ): Promise<{ readonly serverWikiId: bigint; readonly spaceId: bigint }> {
    const serverId = parseServerId(serverIdInput);
    if (lock) {
      await store.$queryRaw<Array<{ id: string }>>`SELECT id FROM Server WHERE id = ${serverId} FOR UPDATE`;
    }
    const server = await store.server.findUnique({ where: { id: serverId }, select: { wikiSpaceId: true, wikiSlug: true } });
    if (!server?.wikiSpaceId || !server.wikiSlug) throw new NotFoundException('연결된 서버 위키가 없습니다.');
    if (lock) {
      await store.$queryRaw<Array<{ id: bigint }>>`
        SELECT id FROM server_wikis WHERE vote_server_id = ${serverId} FOR UPDATE
      `;
    }
    const wiki = await store.serverWiki.findUnique({
      where: { voteServerId: serverId },
      select: { id: true, spaceId: true, slug: true, status: true },
    });
    if (!wiki || wiki.status !== 'active' || wiki.spaceId !== server.wikiSpaceId || wiki.slug !== server.wikiSlug) {
      throw new NotFoundException('연결된 서버 위키가 없습니다.');
    }
    return { serverWikiId: wiki.id, spaceId: wiki.spaceId };
  }

  private audit(
    store: Prisma.TransactionClient,
    action: string,
    actorAccountId: string,
    serverWikiId: bigint,
    metadata: unknown,
    createdAt: Date,
  ): Promise<void> {
    return writeAuditEvent(store, action, {
      category: 'server', actorAccountId, subjectType: 'server_wiki', subjectId: serverWikiId,
      metadata, createdAt,
    });
  }
}

export function normalizeCustomHostname(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.+$/u, '');
  if (!trimmed || trimmed.length > 253 || /[:/@\\\s\p{Cc}\p{Cf}]/u.test(trimmed) || isIP(trimmed)) {
    throw invalidHostname();
  }
  const ascii = domainToASCII(trimmed).toLowerCase();
  if (!ascii || ascii.length > 253 || ascii.includes('..')) throw invalidHostname();
  const labels = ascii.split('.');
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw invalidHostname();
  }
  const parsed = parseDomain(ascii, { allowPrivateDomains: false });
  if (!parsed.isIcann || !parsed.domain || parsed.domain === parsed.publicSuffix) throw invalidHostname();
  if (RESERVED_SUFFIXES.some((suffix) => ascii === suffix || ascii.endsWith(`.${suffix}`))) {
    throw new BadRequestException('MineWiki 서비스 도메인은 커스텀 도메인으로 사용할 수 없습니다.');
  }
  return ascii;
}

function normalizeRoutingTarget(value: string): string {
  try {
    return normalizeDnsName(value);
  } catch {
    return 'domains.minewiki.kr';
  }
}

function normalizeDnsName(value: string): string {
  const normalized = domainToASCII(value.trim().toLowerCase().replace(/\.+$/u, ''));
  if (!normalized || normalized.length > 253 || normalized.includes('/') || normalized.includes(':')) throw invalidHostname();
  return normalized;
}

function challengeName(hostname: string): string {
  return `_minewiki-challenge.${hostname}`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeHashEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function response(
  domain: {
    hostname: string; status: string; version: number; verificationExpiresAt: Date;
    verifiedAt: Date | null; activatedAt: Date | null; tlsReadyAt: Date | null;
    lastCheckedAt: Date | null; nextCheckAt: Date | null; consecutiveFailures: number;
  },
  routingTarget: string,
  token: string | null,
): ServerWikiDomainResponse {
  const status = DOMAIN_STATUS.includes(domain.status as (typeof DOMAIN_STATUS)[number])
    ? domain.status as (typeof DOMAIN_STATUS)[number]
    : 'disabled';
  return {
    hostname: domain.hostname,
    status,
    version: domain.version,
    challenge: {
      name: challengeName(domain.hostname),
      value: token ? `${TOKEN_PREFIX}${token}` : null,
      expiresAt: domain.verificationExpiresAt.toISOString(),
    },
    routing: { type: 'CNAME', name: domain.hostname, value: routingTarget },
    verifiedAt: domain.verifiedAt?.toISOString() ?? null,
    activatedAt: domain.activatedAt?.toISOString() ?? null,
    tlsReadyAt: domain.tlsReadyAt?.toISOString() ?? null,
    lastCheckedAt: domain.lastCheckedAt?.toISOString() ?? null,
    nextCheckAt: domain.nextCheckAt?.toISOString() ?? null,
    consecutiveFailures: domain.consecutiveFailures,
  };
}

function parseServerId(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new BadRequestException('serverId가 올바르지 않습니다.');
  return value.toLowerCase();
}

function invalidHostname(): BadRequestException {
  return new BadRequestException('루트 도메인이 아닌 실제 공개 호스트 이름을 입력하세요.');
}

function staleDomainVersion(): ConflictException {
  return new ConflictException('도메인 설정이 다른 요청에서 변경되었습니다. 최신 상태를 다시 불러오세요.');
}

function domainNotFound(): NotFoundException {
  return new NotFoundException('서버 위키 도메인을 찾을 수 없습니다.');
}
