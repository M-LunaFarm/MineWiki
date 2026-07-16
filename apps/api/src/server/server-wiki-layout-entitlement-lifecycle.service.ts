import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, type ServerWikiLayoutEntitlement } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { toAuditJson } from '../events/business-event.service';

export interface BillingEntitlementSweepResult {
  readonly examined: number;
  readonly expired: number;
  readonly downgraded: number;
  readonly skipped: number;
  readonly failed: number;
}

const DEFAULT_SWEEP_LIMIT = 100;
const MAX_SWEEP_LIMIT = 100;

@Injectable()
export class ServerWikiLayoutEntitlementLifecycleService {
  constructor(private readonly prisma: PrismaService) {}

  async processDue(
    limitInput: number = DEFAULT_SWEEP_LIMIT,
    now = new Date(),
  ): Promise<BillingEntitlementSweepResult> {
    const limit = parseSweepLimit(limitInput);
    const candidates = await this.prisma.serverWikiLayoutEntitlement.findMany({
      where: { status: 'active', expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true },
    });
    const result = { examined: candidates.length, expired: 0, downgraded: 0, skipped: 0, failed: 0 };
    for (const candidate of candidates) {
      try {
        const transition = await this.expireOne(candidate.id, now);
        if (!transition.expired) result.skipped += 1;
        else {
          result.expired += 1;
          if (transition.downgraded) result.downgraded += 1;
        }
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }

  private expireOne(entitlementId: bigint, now: Date): Promise<{ expired: boolean; downgraded: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: bigint }>>`
        SELECT id
        FROM server_wiki_layout_entitlements
        WHERE id = ${entitlementId}
        FOR UPDATE
      `;
      const current = await tx.serverWikiLayoutEntitlement.findUnique({ where: { id: entitlementId } });
      if (!isDue(current, now)) return { expired: false, downgraded: false };

      await tx.$queryRaw<Array<{ id: bigint }>>`
        SELECT id FROM server_wikis WHERE id = ${current.serverWikiId} FOR UPDATE
      `;
      await tx.$queryRaw<Array<{ id: bigint }>>`
        SELECT id
        FROM server_wiki_layout_entitlements
        WHERE server_wiki_id = ${current.serverWikiId}
        ORDER BY id
        FOR UPDATE
      `;
      const [serverWiki, entitlements] = await Promise.all([
        tx.serverWiki.findUnique({
          where: { id: current.serverWikiId },
          select: { id: true, voteServerId: true, layoutKey: true },
        }),
        tx.serverWikiLayoutEntitlement.findMany({
          where: { serverWikiId: current.serverWikiId },
          orderBy: { id: 'asc' },
        }),
      ]);
      const updated = await tx.serverWikiLayoutEntitlement.update({
        where: { id: current.id },
        data: { status: 'expired' },
      });
      const covered = entitlements.some((row) => (
        row.id !== current.id
        && row.layoutKey === current.layoutKey
        && isCurrent(row, now)
      ));
      const downgraded = Boolean(
        serverWiki
        && serverWiki.layoutKey === current.layoutKey
        && !covered
      );
      if (downgraded && serverWiki) {
        await tx.serverWiki.update({
          where: { id: serverWiki.id },
          data: {
            layoutKey: 'docs',
            layoutUpdatedAt: now,
            layoutUpdatedBy: null,
            updatedAt: now,
          },
        });
      }
      await tx.auditEvent.create({
        data: {
          category: 'billing',
          action: 'billing.entitlement.expired',
          severity: 'info',
          actorAccountId: null,
          subjectType: 'server_wiki_layout_entitlement',
          subjectId: current.id.toString(),
          metadata: toAuditJson({
            systemActor: 'internal:billing-lifecycle-worker',
            serverId: serverWiki?.voteServerId ?? null,
            serverWikiId: current.serverWikiId,
            entitlementId: current.id,
            oldValue: entitlementSnapshot(current),
            newValue: entitlementSnapshot(updated),
            selectedLayout: {
              before: serverWiki?.layoutKey ?? null,
              after: downgraded ? 'docs' : serverWiki?.layoutKey ?? null,
            },
            reason: 'Entitlement expiry reached.',
          }),
        },
      });
      return { expired: true, downgraded };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }
}

function parseSweepLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_SWEEP_LIMIT) {
    throw new BadRequestException(`limit must be between 1 and ${MAX_SWEEP_LIMIT}.`);
  }
  return value;
}

function isDue(
  row: ServerWikiLayoutEntitlement | null,
  now: Date,
): row is ServerWikiLayoutEntitlement & { expiresAt: Date } {
  return Boolean(row?.status === 'active' && row.expiresAt && row.expiresAt.getTime() <= now.getTime());
}

function isCurrent(row: ServerWikiLayoutEntitlement, now: Date): boolean {
  return row.status === 'active'
    && row.startsAt.getTime() <= now.getTime()
    && (row.expiresAt === null || row.expiresAt.getTime() > now.getTime());
}

function entitlementSnapshot(row: ServerWikiLayoutEntitlement) {
  return {
    id: row.id,
    serverWikiId: row.serverWikiId,
    layoutKey: row.layoutKey,
    status: row.status,
    source: row.source,
    externalReference: row.externalReference,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    updatedAt: row.updatedAt,
  };
}
