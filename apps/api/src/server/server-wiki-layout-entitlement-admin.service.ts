import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type ServerWikiLayoutEntitlement } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { toAuditJson } from '../events/business-event.service';
import { writeAuditRecord } from '../events/audit-event-writer';

export const PREMIUM_SERVER_WIKI_LAYOUTS = ['handbook', 'brand'] as const;
export type PremiumServerWikiLayout = (typeof PREMIUM_SERVER_WIKI_LAYOUTS)[number];

export interface GrantServerWikiLayoutEntitlementInput {
  readonly layoutKey: PremiumServerWikiLayout;
  readonly startsAt: string;
  readonly expiresAt: string;
  readonly source: string;
  readonly externalRef?: string;
  readonly reason: string;
}

export interface ExtendServerWikiLayoutEntitlementInput {
  readonly expiresAt: string;
  readonly reason: string;
}

export interface RevokeServerWikiLayoutEntitlementInput {
  readonly reason: string;
}

export interface ServerWikiLayoutEntitlementItem {
  readonly id: string;
  readonly serverWikiId: string;
  readonly layoutKey: string;
  readonly status: string;
  readonly source: string;
  readonly externalRef: string | null;
  readonly startsAt: string;
  readonly expiresAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ServerWikiLayoutEntitlementHistory {
  readonly serverId: string;
  readonly serverWikiId: string;
  readonly items: readonly ServerWikiLayoutEntitlementItem[];
  readonly nextCursor: string | null;
}

interface LinkedServerWiki {
  readonly serverId: string;
  readonly serverWikiId: bigint;
  readonly spaceId: bigint;
  readonly selectedLayout: string;
}

interface PreparedGrantInput {
  readonly layoutKey: PremiumServerWikiLayout;
  readonly startsAt: Date;
  readonly expiresAt: Date;
  readonly source: string;
  readonly externalRef: string | null;
  readonly reason: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UNSIGNED_BIGINT_PATTERN = /^(?:[1-9][0-9]*)$/u;
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
const EXTERNAL_REFERENCE_PATTERN = /^[\x21-\x7e]{1,191}$/u;
const REASON_MIN_LENGTH = 5;
const REASON_MAX_LENGTH = 500;
const MAX_HISTORY_LIMIT = 100;
const MAX_ENTITLEMENT_DURATION_MS = 10 * 366 * 24 * 60 * 60 * 1000;
const MAX_SERIALIZABLE_ATTEMPTS = 3;
const ENTITLEMENT_SUBJECT_TYPE = 'server_wiki_layout_entitlement';

@Injectable()
export class ServerWikiLayoutEntitlementAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    serverIdInput: string,
    input: { readonly limit?: number; readonly before?: string } = {},
  ): Promise<ServerWikiLayoutEntitlementHistory> {
    const serverId = parseServerId(serverIdInput);
    const limit = parseLimit(input.limit);
    const before = input.before === undefined ? null : parseEntitlementId(input.before);
    const context = await this.resolveLinkedServerWiki(this.prisma, serverId);
    const rows = await this.prisma.serverWikiLayoutEntitlement.findMany({
      where: {
        serverWikiId: context.serverWikiId,
        id: before === null ? undefined : { lt: before },
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      serverId: context.serverId,
      serverWikiId: context.serverWikiId.toString(),
      items: page.map(toItem),
      nextCursor: hasMore ? page.at(-1)?.id.toString() ?? null : null,
    };
  }

  async grant(
    serverIdInput: string,
    input: GrantServerWikiLayoutEntitlementInput,
    actorAccountIdInput: string,
  ): Promise<ServerWikiLayoutEntitlementItem> {
    const serverId = parseServerId(serverIdInput);
    const actorAccountId = parseActorAccountId(actorAccountIdInput);
    const prepared = prepareGrantInput(input);

    try {
      return await this.serializable(async (tx) => {
        const context = await this.lockLinkedServerWiki(tx, serverId);
        await this.lockEntitlements(tx, context.serverWikiId);
        if (prepared.externalRef !== null) {
          await this.lockExternalReference(tx, prepared.externalRef);
          const existing = await tx.serverWikiLayoutEntitlement.findUnique({
            where: { externalReference: prepared.externalRef },
          });
          if (existing) {
            return this.resolveGrantReplay(tx, context, existing, prepared);
          }
        }

        const actorProfile = await tx.wikiProfile.findUnique({
          where: { accountId: actorAccountId },
          select: { id: true },
        });
        const entitlement = await tx.serverWikiLayoutEntitlement.create({
          data: {
            serverWikiId: context.serverWikiId,
            layoutKey: prepared.layoutKey,
            status: 'active',
            source: prepared.source,
            externalReference: prepared.externalRef,
            startsAt: prepared.startsAt,
            expiresAt: prepared.expiresAt,
            createdBy: actorProfile?.id ?? null,
          },
        });
        await this.appendAudit(tx, {
          action: 'billing.entitlement.granted',
          actorAccountId,
          context,
          entitlementId: entitlement.id,
          oldValue: null,
          newValue: toItem(entitlement),
          reason: prepared.reason,
          requestFingerprint: grantFingerprint(prepared),
        });
        return toItem(entitlement);
      });
    } catch (error) {
      if (prepared.externalRef !== null && prismaCode(error) === 'P2002') {
        return this.resolveConcurrentGrantReplay(serverId, prepared);
      }
      throw normalizeMutationError(error);
    }
  }

  async extend(
    serverIdInput: string,
    entitlementIdInput: string,
    input: ExtendServerWikiLayoutEntitlementInput,
    actorAccountIdInput: string,
  ): Promise<ServerWikiLayoutEntitlementItem> {
    const serverId = parseServerId(serverIdInput);
    const entitlementId = parseEntitlementId(entitlementIdInput);
    const actorAccountId = parseActorAccountId(actorAccountIdInput);
    const expiresAt = parseDateTime(input.expiresAt, 'expiresAt');
    const reason = parseReason(input.reason);

    try {
      return await this.serializable(async (tx) => {
        const context = await this.lockLinkedServerWiki(tx, serverId);
        const rows = await this.lockEntitlements(tx, context.serverWikiId);
        const current = requireEntitlement(rows, entitlementId);
        assertManuallyManagedEntitlement(current);
        if (current.status !== 'active') {
          throw new ConflictException('Only an active entitlement can be extended.');
        }
        if (current.expiresAt === null) {
          throw new ConflictException('An entitlement without an expiry cannot be extended.');
        }
        if (expiresAt.getTime() <= current.expiresAt.getTime()) {
          throw new BadRequestException('expiresAt must be later than the current expiry.');
        }
        assertDuration(current.startsAt, expiresAt);

        const oldValue = toItem(current);
        const updated = await tx.serverWikiLayoutEntitlement.update({
          where: { id: current.id },
          data: { expiresAt },
        });
        await this.appendAudit(tx, {
          action: 'billing.entitlement.extended',
          actorAccountId,
          context,
          entitlementId: updated.id,
          oldValue,
          newValue: toItem(updated),
          reason,
        });
        return toItem(updated);
      });
    } catch (error) {
      throw normalizeMutationError(error);
    }
  }

  async revoke(
    serverIdInput: string,
    entitlementIdInput: string,
    input: RevokeServerWikiLayoutEntitlementInput,
    actorAccountIdInput: string,
  ): Promise<ServerWikiLayoutEntitlementItem> {
    const serverId = parseServerId(serverIdInput);
    const entitlementId = parseEntitlementId(entitlementIdInput);
    const actorAccountId = parseActorAccountId(actorAccountIdInput);
    const reason = parseReason(input.reason);

    try {
      return await this.serializable(async (tx) => {
        const context = await this.lockLinkedServerWiki(tx, serverId);
        const rows = await this.lockEntitlements(tx, context.serverWikiId);
        const current = requireEntitlement(rows, entitlementId);
        assertManuallyManagedEntitlement(current);
        if (current.status !== 'active') {
          throw new ConflictException('Only an active entitlement can be revoked.');
        }

        const now = new Date();
        const oldValue = toItem(current);
        const updated = await tx.serverWikiLayoutEntitlement.update({
          where: { id: current.id },
          data: { status: 'revoked' },
        });
        const hasOtherActiveEntitlement = rows.some((row) => (
          row.id !== current.id
          && row.layoutKey === current.layoutKey
          && isCurrentlyActive(row, now)
        ));
        const shouldDowngrade = (
          context.selectedLayout === current.layoutKey
          && !hasOtherActiveEntitlement
        );
        if (shouldDowngrade) {
          await tx.serverWiki.update({
            where: { id: context.serverWikiId },
            data: {
              layoutKey: 'docs',
              layoutUpdatedAt: now,
              layoutUpdatedBy: null,
              updatedAt: now,
            },
          });
        }
        await this.appendAudit(tx, {
          action: 'billing.entitlement.revoked',
          actorAccountId,
          context,
          entitlementId: updated.id,
          oldValue: {
            entitlement: oldValue,
            selectedLayout: context.selectedLayout,
          },
          newValue: {
            entitlement: toItem(updated),
            selectedLayout: shouldDowngrade ? 'docs' : context.selectedLayout,
          },
          reason,
        });
        return toItem(updated);
      });
    } catch (error) {
      throw normalizeMutationError(error);
    }
  }

  private async resolveConcurrentGrantReplay(
    serverId: string,
    input: PreparedGrantInput,
  ): Promise<ServerWikiLayoutEntitlementItem> {
    return this.prisma.$transaction(async (tx) => {
      const context = await this.resolveLinkedServerWiki(tx, serverId);
      const existing = await tx.serverWikiLayoutEntitlement.findUnique({
        where: { externalReference: input.externalRef! },
      });
      if (!existing) throw entitlementConflict();
      return this.resolveGrantReplay(tx, context, existing, input);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async resolveGrantReplay(
    tx: Prisma.TransactionClient,
    context: LinkedServerWiki,
    existing: ServerWikiLayoutEntitlement,
    input: PreparedGrantInput,
  ): Promise<ServerWikiLayoutEntitlementItem> {
    const audit = await tx.auditEvent.findFirst({
      where: {
        action: 'billing.entitlement.granted',
        subjectType: ENTITLEMENT_SUBJECT_TYPE,
        subjectId: existing.id.toString(),
      },
      orderBy: { createdAt: 'asc' },
      select: { metadata: true },
    });
    const metadata = asRecord(audit?.metadata);
    const matches = (
      existing.serverWikiId === context.serverWikiId
      && existing.externalReference === input.externalRef
      && metadata?.requestFingerprint === grantFingerprint(input)
    );
    if (!matches) throw entitlementConflict();
    return toItem(existing);
  }

  private async resolveLinkedServerWiki(
    store: Prisma.TransactionClient | PrismaService,
    serverId: string,
  ): Promise<LinkedServerWiki> {
    const server = await store.server.findUnique({
      where: { id: serverId },
      select: { id: true, wikiSpaceId: true, wikiSlug: true },
    });
    if (!server) throw new NotFoundException('Server not found.');
    const serverWiki = await store.serverWiki.findUnique({
      where: { voteServerId: server.id },
      select: { id: true, spaceId: true, slug: true, status: true, layoutKey: true },
    });
    if (!serverWiki) throw new NotFoundException('Server wiki not found.');
    if (
      serverWiki.status !== 'active'
      || server.wikiSpaceId !== serverWiki.spaceId
      || server.wikiSlug !== serverWiki.slug
    ) {
      throw new ConflictException('Server and active server wiki linkage is inconsistent.');
    }
    return {
      serverId: server.id,
      serverWikiId: serverWiki.id,
      spaceId: serverWiki.spaceId,
      selectedLayout: serverWiki.layoutKey,
    };
  }

  private async lockLinkedServerWiki(
    tx: Prisma.TransactionClient,
    serverId: string,
  ): Promise<LinkedServerWiki> {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM \`Server\` WHERE id = ${serverId} FOR UPDATE
    `;
    await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM server_wikis WHERE vote_server_id = ${serverId} FOR UPDATE
    `;
    return this.resolveLinkedServerWiki(tx, serverId);
  }

  private async lockEntitlements(
    tx: Prisma.TransactionClient,
    serverWikiId: bigint,
  ): Promise<ServerWikiLayoutEntitlement[]> {
    await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id
      FROM server_wiki_layout_entitlements
      WHERE server_wiki_id = ${serverWikiId}
      ORDER BY id
      FOR UPDATE
    `;
    return tx.serverWikiLayoutEntitlement.findMany({
      where: { serverWikiId },
      orderBy: { id: 'asc' },
    });
  }

  private lockExternalReference(
    tx: Prisma.TransactionClient,
    externalRef: string,
  ): Promise<unknown> {
    return tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id
      FROM server_wiki_layout_entitlements
      WHERE external_reference = ${externalRef}
      FOR UPDATE
    `;
  }

  private async appendAudit(
    tx: Prisma.TransactionClient,
    input: {
      readonly action: 'billing.entitlement.granted' | 'billing.entitlement.extended' | 'billing.entitlement.revoked';
      readonly actorAccountId: string;
      readonly context: LinkedServerWiki;
      readonly entitlementId: bigint;
      readonly oldValue: unknown;
      readonly newValue: unknown;
      readonly reason: string;
      readonly requestFingerprint?: string;
    },
  ): Promise<void> {
    await writeAuditRecord(tx, {
      data: {
        category: 'billing',
        action: input.action,
        severity: input.action === 'billing.entitlement.revoked' ? 'warning' : 'info',
        actorAccountId: input.actorAccountId,
        subjectType: ENTITLEMENT_SUBJECT_TYPE,
        subjectId: input.entitlementId.toString(),
        metadata: toAuditJson({
          actorAccountId: input.actorAccountId,
          serverId: input.context.serverId,
          serverWikiId: input.context.serverWikiId,
          entitlementId: input.entitlementId,
          oldValue: input.oldValue,
          newValue: input.newValue,
          reason: input.reason,
          requestFingerprint: input.requestFingerprint ?? null,
        }),
      },
    });
  }

  private async serializable<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        if (prismaCode(error) !== 'P2034' || attempt === MAX_SERIALIZABLE_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw entitlementConflict();
  }
}

function prepareGrantInput(input: GrantServerWikiLayoutEntitlementInput): PreparedGrantInput {
  const layoutKey = parseLayoutKey(input.layoutKey);
  const startsAt = parseDateTime(input.startsAt, 'startsAt');
  const expiresAt = parseDateTime(input.expiresAt, 'expiresAt');
  if (expiresAt.getTime() <= startsAt.getTime()) {
    throw new BadRequestException('expiresAt must be later than startsAt.');
  }
  assertDuration(startsAt, expiresAt);
  return {
    layoutKey,
    startsAt,
    expiresAt,
    source: parseSource(input.source),
    externalRef: parseExternalReference(input.externalRef),
    reason: parseReason(input.reason),
  };
}

function grantFingerprint(input: PreparedGrantInput): string {
  return createHash('sha256').update(JSON.stringify([
    input.layoutKey,
    input.startsAt.toISOString(),
    input.expiresAt.toISOString(),
    input.source,
    input.externalRef,
    input.reason,
  ])).digest('hex');
}

function parseServerId(value: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException('serverId must be a UUID.');
  }
  return value.toLowerCase();
}

function parseActorAccountId(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 191) {
    throw new BadRequestException('actorAccountId is invalid.');
  }
  return value;
}

function parseEntitlementId(value: string): bigint {
  if (typeof value !== 'string' || !UNSIGNED_BIGINT_PATTERN.test(value)) {
    throw new BadRequestException('entitlementId must be a positive integer.');
  }
  const parsed = BigInt(value);
  if (parsed > MAX_UNSIGNED_BIGINT) {
    throw new BadRequestException('entitlementId is outside the supported range.');
  }
  return parsed;
}

function parseLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    throw new BadRequestException(`limit must be between 1 and ${MAX_HISTORY_LIMIT}.`);
  }
  return limit;
}

function parseLayoutKey(value: string): PremiumServerWikiLayout {
  if (!(PREMIUM_SERVER_WIKI_LAYOUTS as readonly string[]).includes(value)) {
    throw new BadRequestException('layoutKey must be handbook or brand.');
  }
  return value as PremiumServerWikiLayout;
}

function parseDateTime(value: string, field: string): Date {
  if (typeof value !== 'string' || !RFC3339_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be an RFC 3339 date-time with a timezone.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new BadRequestException(`${field} is not a valid date-time.`);
  }
  return parsed;
}

function parseSource(value: string): string {
  const source = typeof value === 'string' ? value.trim() : '';
  if (!SOURCE_PATTERN.test(source)) {
    throw new BadRequestException('source must contain 1 to 32 lowercase letters, digits, dots, underscores, or hyphens.');
  }
  return source;
}

function parseExternalReference(value: string | undefined): string | null {
  if (value === undefined) return null;
  const externalRef = typeof value === 'string' ? value.trim() : '';
  if (
    !EXTERNAL_REFERENCE_PATTERN.test(externalRef)
    || externalRef.normalize('NFKC') !== externalRef
  ) {
    throw new BadRequestException('externalRef must contain 1 to 191 normalized printable ASCII characters without spaces.');
  }
  if (externalRef.toLowerCase().startsWith('paddle:')) {
    throw new BadRequestException('externalRef uses a reserved billing provider prefix.');
  }
  return externalRef;
}

function parseReason(value: string): string {
  const reason = typeof value === 'string' ? value.trim() : '';
  if (reason.length < REASON_MIN_LENGTH || reason.length > REASON_MAX_LENGTH) {
    throw new BadRequestException(`reason must contain between ${REASON_MIN_LENGTH} and ${REASON_MAX_LENGTH} characters.`);
  }
  return reason;
}

function assertDuration(startsAt: Date, expiresAt: Date): void {
  if (expiresAt.getTime() - startsAt.getTime() > MAX_ENTITLEMENT_DURATION_MS) {
    throw new BadRequestException('An entitlement cannot span more than 10 years.');
  }
}

function requireEntitlement(
  rows: readonly ServerWikiLayoutEntitlement[],
  entitlementId: bigint,
): ServerWikiLayoutEntitlement {
  const entitlement = rows.find((row) => row.id === entitlementId);
  if (!entitlement) throw new NotFoundException('Entitlement not found for this server wiki.');
  return entitlement;
}

function isCurrentlyActive(entitlement: ServerWikiLayoutEntitlement, now: Date): boolean {
  return entitlement.status === 'active'
    && entitlement.startsAt.getTime() <= now.getTime()
    && (entitlement.expiresAt === null || entitlement.expiresAt.getTime() > now.getTime());
}

function assertManuallyManagedEntitlement(entitlement: ServerWikiLayoutEntitlement): void {
  if (entitlement.source === 'paddle' || entitlement.externalReference?.toLowerCase().startsWith('paddle:')) {
    throw new ConflictException('Paddle entitlements are managed only by verified billing events.');
  }
}

function toItem(entitlement: ServerWikiLayoutEntitlement): ServerWikiLayoutEntitlementItem {
  return {
    id: entitlement.id.toString(),
    serverWikiId: entitlement.serverWikiId.toString(),
    layoutKey: entitlement.layoutKey,
    status: entitlement.status,
    source: entitlement.source,
    externalRef: entitlement.externalReference,
    startsAt: entitlement.startsAt.toISOString(),
    expiresAt: entitlement.expiresAt?.toISOString() ?? null,
    createdBy: entitlement.createdBy?.toString() ?? null,
    createdAt: entitlement.createdAt.toISOString(),
    updatedAt: entitlement.updatedAt.toISOString(),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function prismaCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : null;
}

function normalizeMutationError(error: unknown): unknown {
  const code = prismaCode(error);
  if (code === 'P2002' || code === 'P2034') return entitlementConflict();
  return error;
}

function entitlementConflict(): ConflictException {
  return new ConflictException('The entitlement changed concurrently or the externalRef belongs to a different payload.');
}
