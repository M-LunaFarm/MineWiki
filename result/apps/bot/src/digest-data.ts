import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import type { DigestSummary, RankEntry, RisingEntry } from './digest';

export async function fetchDigestSummary(
  prisma: PrismaClient,
  reference: DateTime = DateTime.utc()
): Promise<DigestSummary> {
  const since = reference.minus({ hours: 24 }).toJSDate();

  const [votes, reviews, topServer, risingStats, reviewRows] = await Promise.all([
    prisma.vote.count({
      where: { votedAt: { gte: since } }
    }),
    prisma.serverReview.count({
      where: { createdAt: { gte: since }, visibility: 'public' }
    }),
    prisma.serverStats.findFirst({
      orderBy: { rankCurrent: 'asc' },
      select: { rankDelta24h: true }
    }),
    prisma.serverStats.findMany({
      where: { rankDelta24h: { gt: 0 } },
      orderBy: { rankDelta24h: 'desc' },
      take: 3,
      include: { server: { select: { name: true } } }
    }),
    prisma.serverReview.findMany({
      where: { createdAt: { gte: since }, visibility: 'public' },
      orderBy: [{ rating: 'desc' }, { createdAt: 'desc' }],
      take: 2,
      include: { server: { select: { name: true } } }
    })
  ]);

  return {
    metrics: {
      votes,
      reviews,
      rankDelta: topServer?.rankDelta24h ?? 0
    },
    rising: risingStats.map((entry) => ({
      name: entry.server.name,
      rank: entry.rankCurrent,
      delta: entry.rankDelta24h
    })),
    reviews: reviewRows.map((entry) => ({
      server: entry.server.name,
      body: entry.body,
      rating: entry.rating
    }))
  };
}

export async function fetchRankEntries(
  prisma: PrismaClient,
  limit = 3
): Promise<RankEntry[]> {
  const rows = await prisma.serverStats.findMany({
    orderBy: { rankCurrent: 'asc' },
    take: limit,
    include: { server: { select: { name: true } } }
  });

  return rows.map((entry) => ({
    name: entry.server.name,
    votes: entry.votesLast24h,
    rank: entry.rankCurrent,
    delta: entry.rankDelta24h
  }));
}

export async function fetchRisingEntries(
  prisma: PrismaClient,
  limit = 3
): Promise<RisingEntry[]> {
  const rows = await prisma.serverStats.findMany({
    where: { rankDelta24h: { gt: 0 } },
    orderBy: { rankDelta24h: 'desc' },
    take: limit,
    include: { server: { select: { name: true } } }
  });

  return rows.map((entry) => ({
    name: entry.server.name,
    rank: entry.rankCurrent,
    delta: entry.rankDelta24h
  }));
}
