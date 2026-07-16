import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

export interface ActiveCanonicalAccountGroup {
  readonly accountIds: readonly string[];
}

export interface CanonicalAccountGroup {
  readonly seedAccountId: string;
  readonly canonicalAccountId: string;
  readonly accountIds: readonly string[];
}

export async function withCanonicalAccountGroups<T>(
  prisma: PrismaService,
  seedAccountIds: readonly string[],
  write: (tx: Prisma.TransactionClient, groups: readonly CanonicalAccountGroup[]) => Promise<T>,
): Promise<T> {
  const seeds = uniqueSorted(seedAccountIds);
  if (seeds.length === 0) throw new NotFoundException('계정을 찾을 수 없습니다.');

  return prisma.$transaction(async (tx) => {
    let groups = await Promise.all(seeds.map((seed) => resolveCanonicalAccountGroup(tx, seed)));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await lockAccounts(tx, uniqueSorted(groups.flatMap((group) => group.accountIds)));
      const resolved = await Promise.all(seeds.map((seed) => resolveCanonicalAccountGroup(tx, seed)));
      if (sameGroups(groups, resolved)) return write(tx, resolved);
      groups = resolved;
    }
    throw new ConflictException('계정 연결 상태가 계속 변경되고 있습니다. 다시 시도해 주세요.');
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function withActiveCanonicalAccountGroup<T>(
  prisma: PrismaService,
  seedAccountIds: readonly string[],
  write: (tx: Prisma.TransactionClient, group: ActiveCanonicalAccountGroup) => Promise<T>,
  options: { readonly inactiveError?: () => Error } = {},
): Promise<T> {
  const seeds = uniqueSorted(seedAccountIds);
  if (seeds.length === 0) throw new NotFoundException('계정을 찾을 수 없습니다.');

  return prisma.$transaction(async (tx) => {
    let accountIds = await resolveCanonicalGroup(tx, seeds);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await lockAccounts(tx, accountIds);
      const resolved = await resolveCanonicalGroup(tx, seeds);
      if (sameIds(accountIds, resolved)) {
        const active = await tx.account.count({
          where: { id: { in: accountIds }, lifecycleStatus: 'active' },
        });
        if (active !== accountIds.length) {
          throw options.inactiveError?.() ??
            new ConflictException('종료가 진행 중인 계정에는 인증 정보를 쓸 수 없습니다.');
        }
        return write(tx, { accountIds });
      }
      accountIds = uniqueSorted([...accountIds, ...resolved]);
    }
    throw new ConflictException('계정 연결 상태가 계속 변경되고 있습니다. 다시 시도해 주세요.');
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function resolveCanonicalGroup(
  tx: Prisma.TransactionClient,
  seedAccountIds: readonly string[],
): Promise<string[]> {
  const connected = new Set(seedAccountIds);
  let frontier = [...connected];
  let foundSeedCount = 0;

  while (frontier.length > 0) {
    const [accounts, links] = await Promise.all([
      tx.account.findMany({
        where: { OR: [{ id: { in: frontier } }, { canonicalAccountId: { in: frontier } }] },
        select: { id: true, canonicalAccountId: true },
      }),
      tx.accountLink.findMany({
        where: { OR: [{ primaryAccountId: { in: frontier } }, { linkedAccountId: { in: frontier } }] },
        select: { primaryAccountId: true, linkedAccountId: true },
      }),
    ]);
    if (foundSeedCount === 0) {
      foundSeedCount = accounts.filter((account) => seedAccountIds.includes(account.id)).length;
    }
    const next: string[] = [];
    for (const id of [
      ...accounts.flatMap((account) => [account.id, ...(account.canonicalAccountId ? [account.canonicalAccountId] : [])]),
      ...links.flatMap((link) => [link.primaryAccountId, link.linkedAccountId]),
    ]) {
      if (!connected.has(id)) { connected.add(id); next.push(id); }
    }
    frontier = next;
  }

  if (foundSeedCount !== seedAccountIds.length) throw new NotFoundException('계정을 찾을 수 없습니다.');
  return uniqueSorted([...connected]);
}

async function resolveCanonicalAccountGroup(
  tx: Prisma.TransactionClient,
  seedAccountId: string,
): Promise<CanonicalAccountGroup> {
  const seed = await tx.account.findUnique({
    where: { id: seedAccountId },
    select: { id: true, canonicalAccountId: true },
  });
  if (!seed) throw new NotFoundException('계정을 찾을 수 없습니다.');
  const canonicalAccountId = seed.canonicalAccountId ?? seed.id;
  const connected = new Set([seed.id, canonicalAccountId]);
  let frontier = [...connected];

  while (frontier.length > 0) {
    const [accounts, links] = await Promise.all([
      tx.account.findMany({
        where: { OR: [{ id: { in: frontier } }, { canonicalAccountId: { in: frontier } }] },
        select: { id: true, canonicalAccountId: true },
      }),
      tx.accountLink.findMany({
        where: { OR: [{ primaryAccountId: { in: frontier } }, { linkedAccountId: { in: frontier } }] },
        select: { primaryAccountId: true, linkedAccountId: true },
      }),
    ]);
    const next: string[] = [];
    for (const id of [
      ...accounts.flatMap((account) => [account.id, ...(account.canonicalAccountId ? [account.canonicalAccountId] : [])]),
      ...links.flatMap((link) => [link.primaryAccountId, link.linkedAccountId]),
    ]) {
      if (!connected.has(id)) { connected.add(id); next.push(id); }
    }
    frontier = next;
  }

  return {
    seedAccountId,
    canonicalAccountId,
    accountIds: uniqueSorted([...connected]),
  };
}

async function lockAccounts(tx: Prisma.TransactionClient, accountIds: readonly string[]): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM \`Account\` WHERE id IN (${Prisma.join(accountIds)}) ORDER BY id FOR UPDATE`,
  );
  if (rows.length !== accountIds.length) throw new NotFoundException('계정을 찾을 수 없습니다.');
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameGroups(
  left: readonly CanonicalAccountGroup[],
  right: readonly CanonicalAccountGroup[],
): boolean {
  return left.length === right.length && left.every((group, index) => {
    const candidate = right[index];
    return candidate?.seedAccountId === group.seedAccountId &&
      candidate.canonicalAccountId === group.canonicalAccountId &&
      sameIds(group.accountIds, candidate.accountIds);
  });
}
