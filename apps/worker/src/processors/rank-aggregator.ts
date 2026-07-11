import { Logger } from '@minewiki/logger';
import type { RankAggregationJob } from '@minewiki/schemas';
import type { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';

const KST_ZONE = 'Asia/Seoul';
const SPARKLINE_DAYS = 7;

type PrismaHandle = Pick<
  PrismaClient,
  'server' | 'serverStats' | 'serverRankSnapshot' | 'vote' | '$transaction'
>;

type CountMap = Map<string, number>;

export function createRankAggregator(prisma: PrismaHandle) {
  const logger = Logger.child({ component: 'RankAggregator' });

  async function aggregate(job: RankAggregationJob) {
    const processedAt = DateTime.fromISO(job.processedAt, { zone: 'utc' });
    const now = processedAt.isValid ? processedAt : DateTime.utc();

    const last24hStart = now.minus({ hours: 24 }).toJSDate();
    const last7dStart = now.minus({ days: 7 }).toJSDate();
    const monthStart = now.setZone(KST_ZONE).startOf('month').toUTC().toJSDate();

    const [votes24h, votes7d, votesMonth, votesTotal, servers, historicalBestRanks] =
      await Promise.all([
      prisma.vote.groupBy({
        by: ['serverId'],
        where: { votedAt: { gte: last24hStart } },
        _count: { _all: true }
      }),
      prisma.vote.groupBy({
        by: ['serverId'],
        where: { votedAt: { gte: last7dStart } },
        _count: { _all: true }
      }),
      prisma.vote.groupBy({
        by: ['serverId'],
        where: { votedAt: { gte: monthStart } },
        _count: { _all: true }
      }),
      prisma.vote.groupBy({
        by: ['serverId'],
        _count: { _all: true }
      }),
      prisma.server.findMany({
        select: { id: true, name: true, reviewsCount: true }
      }),
      prisma.serverRankSnapshot.groupBy({
        by: ['serverId'],
        _min: { rank: true }
      })
    ]);

    const votes24hMap = toCountMap(votes24h);
    const votes7dMap = toCountMap(votes7d);
    const votesMonthMap = toCountMap(votesMonth);
    const votesTotalMap = toCountMap(votesTotal);
    const rankBestMap = new Map(
      historicalBestRanks.flatMap((entry) =>
        entry._min.rank === null ? [] : [[entry.serverId, entry._min.rank] as const]
      )
    );

    const ranked = servers
      .map((server) => ({
        id: server.id,
        name: server.name,
        reviewsCount: server.reviewsCount,
        votes24h: votes24hMap.get(server.id) ?? 0,
        votes7d: votes7dMap.get(server.id) ?? 0,
        votesMonth: votesMonthMap.get(server.id) ?? 0,
        votesTotal: votesTotalMap.get(server.id) ?? 0
      }))
      .sort((a, b) => {
        if (b.votes24h !== a.votes24h) {
          return b.votes24h - a.votes24h;
        }
        if (b.votes7d !== a.votes7d) {
          return b.votes7d - a.votes7d;
        }
        if (b.reviewsCount !== a.reviewsCount) {
          return b.reviewsCount - a.reviewsCount;
        }
        return a.name.localeCompare(b.name);
      })
      .map((entry, index) => ({
        ...entry,
        rankCurrent: index + 1
      }));

    const previousRankMap = await loadPreviousRanks(prisma, now);

    const sparklineMap = await buildSparkline(prisma, now, servers.map((server) => server.id));

    const updates = ranked.flatMap((entry) => {
      const previousRank = previousRankMap.get(entry.id);
      const rankDelta24h = previousRank ? previousRank - entry.rankCurrent : 0;
      const rankBest = Math.min(rankBestMap.get(entry.id) ?? entry.rankCurrent, entry.rankCurrent);
      const sparkline = sparklineMap.get(entry.id) ?? Array(SPARKLINE_DAYS).fill(0);

      return [
        prisma.serverStats.upsert({
          where: { serverId: entry.id },
          create: {
            serverId: entry.id,
            rankCurrent: entry.rankCurrent,
            rankDelta24h,
            rankBest,
            votesLast24h: entry.votes24h,
            votesLast7d: entry.votes7d,
            votesMonthToDate: entry.votesMonth,
            votesTotal: entry.votesTotal,
            playersOnline: 0,
            playersMax: 0,
            playersLastUpdatedAt: null,
            uptimePercent: 0,
            sparkline,
            latencyMs: 0,
            lastPingAt: null
          },
          update: {
            rankCurrent: entry.rankCurrent,
            rankDelta24h,
            rankBest,
            votesLast24h: entry.votes24h,
            votesLast7d: entry.votes7d,
            votesMonthToDate: entry.votesMonth,
            votesTotal: entry.votesTotal,
            sparkline
          }
        }),
        prisma.server.update({
          where: { id: entry.id },
          data: {
            votes24h: entry.votes24h,
            votesMonthly: entry.votesMonth
          }
        })
      ];
    });

    if (updates.length > 0) {
      await prisma.$transaction(updates);
    }

    await createDailySnapshot(prisma, now, ranked);

    const risers = ranked.filter((entry) => (previousRankMap.get(entry.id) ?? entry.rankCurrent) > entry.rankCurrent).length;
    logger.info({ serversProcessed: ranked.length, risers }, 'Rank aggregation completed');

    return {
      serversProcessed: ranked.length,
      risers
    };
  }

  return { aggregate };
}

async function loadPreviousRanks(prisma: PrismaHandle, now: DateTime): Promise<Map<string, number>> {
  const previousDayStart = now.setZone(KST_ZONE).startOf('day').minus({ days: 1 });
  const previousDayEnd = previousDayStart.plus({ days: 1 });
  const previousSnapshots = await prisma.serverRankSnapshot.findMany({
    where: {
      recordedAt: {
        gte: previousDayStart.toUTC().toJSDate(),
        lt: previousDayEnd.toUTC().toJSDate()
      }
    },
    orderBy: { recordedAt: 'desc' }
  });

  const previousRankMap = new Map<string, number>();
  for (const snapshot of previousSnapshots) {
    if (!previousRankMap.has(snapshot.serverId)) {
      previousRankMap.set(snapshot.serverId, snapshot.rank);
    }
  }
  return previousRankMap;
}

async function buildSparkline(
  prisma: PrismaHandle,
  now: DateTime,
  serverIds: string[]
): Promise<Map<string, number[]>> {
  const sparklineMap = new Map<string, number[]>();
  for (const serverId of serverIds) {
    sparklineMap.set(serverId, Array(SPARKLINE_DAYS).fill(0));
  }

  const baseDay = now.setZone(KST_ZONE).startOf('day');
  for (let offset = SPARKLINE_DAYS - 1; offset >= 0; offset -= 1) {
    const dayStart = baseDay.minus({ days: offset });
    const rangeStart = dayStart.toUTC().toJSDate();
    const rangeEnd = dayStart.plus({ days: 1 }).toUTC().toJSDate();
    const dailyCounts = await prisma.vote.groupBy({
      by: ['serverId'],
      where: {
        votedAt: {
          gte: rangeStart,
          lt: rangeEnd
        }
      },
      _count: { _all: true }
    });
    const index = SPARKLINE_DAYS - 1 - offset;
    for (const entry of dailyCounts) {
      const series = sparklineMap.get(entry.serverId);
      if (!series) {
        continue;
      }
      series[index] = entry._count._all;
    }
  }

  return sparklineMap;
}

async function createDailySnapshot(
  prisma: PrismaHandle,
  now: DateTime,
  ranked: Array<{ id: string; rankCurrent: number; votes24h: number; votesMonth: number }>
): Promise<void> {
  const todayStart = now.setZone(KST_ZONE).startOf('day');
  const todayEnd = todayStart.plus({ days: 1 });
  const existing = await prisma.serverRankSnapshot.findFirst({
    where: {
      recordedAt: {
        gte: todayStart.toUTC().toJSDate(),
        lt: todayEnd.toUTC().toJSDate()
      }
    }
  });

  if (existing) {
    return;
  }

  if (ranked.length === 0) {
    return;
  }

  await prisma.serverRankSnapshot.createMany({
    data: ranked.map((entry) => ({
      serverId: entry.id,
      rank: entry.rankCurrent,
      votes24h: entry.votes24h,
      votesMonthToDate: entry.votesMonth,
      recordedAt: now.toUTC().toJSDate()
    }))
  });
}

function toCountMap(
  records: Array<{ serverId: string; _count: { _all: number } }>
): CountMap {
  return new Map(records.map((record) => [record.serverId, record._count._all]));
}
