import { Logger } from '@minewiki/logger';
import { UnsafeEndpointError, validateOutboundTarget } from '@minewiki/security';
import type { ServerPingJob } from '@minewiki/schemas';
import type { PrismaClient } from '@prisma/client';
import { status, statusBedrock } from 'minecraft-server-util';
import { resolveSrv } from 'node:dns/promises';
import { isIP } from 'node:net';

const PING_TIMEOUT_MS = 5000;
const SAMPLE_RETENTION_DAYS = 7;
const UPTIME_WINDOW_HOURS = 24;
const ALLOW_IPV6 = parseBooleanEnv(process.env.SERVER_PING_ALLOW_IPV6);

type PrismaHandle = Pick<
  PrismaClient,
  'server' | 'serverStats' | 'serverPingSample' | '$transaction'
>;

export function createServerPinger(prisma: PrismaHandle) {
  async function ping(job: ServerPingJob) {
    const target = await resolvePingTarget(job);
    const now = new Date();
    const context = {
      serverId: job.serverId,
      host: target?.host ?? job.host,
      port: target?.port ?? job.port,
      edition: job.edition,
    };

    let online = false;
    let playersOnline: number | null = null;
    let playersMax: number | null = null;
    let latency: number | null = null;
    let motd: string | null = null;
    let version: string | null = null;

    try {
      if (!target) {
        throw new Error('server_ping_target_unresolved');
      }
      const response =
        job.edition === 'bedrock'
          ? await statusBedrock(target.host, target.port, {
              timeout: PING_TIMEOUT_MS,
            })
          : await status(target.host, target.port, { timeout: PING_TIMEOUT_MS });

      online = true;
      const players = extractPlayers(response);
      playersOnline = players.online;
      playersMax = players.max;
      latency = extractLatency(response);
      motd = extractMotd(response);
      version = extractVersion(response);
    } catch (error) {
      Logger.warn({ err: error, ...context }, 'Server ping failed');
    }

    const latencyValue = latency ? Math.max(0, Math.round(latency)) : 0;
    const playersOnlineValue =
      typeof playersOnline === 'number' ? Math.max(0, Math.round(playersOnline)) : 0;
    const playersMaxValue =
      typeof playersMax === 'number' ? Math.max(0, Math.round(playersMax)) : 0;

    const retentionStart = new Date(now.getTime() - SAMPLE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const uptimeStart = new Date(now.getTime() - UPTIME_WINDOW_HOURS * 60 * 60 * 1000);

    await prisma.$transaction(async (tx) => {
      await tx.serverPingSample.create({
        data: {
          serverId: job.serverId,
          timestamp: now,
          online,
          players: online ? playersOnlineValue : null,
          maxPlayers: online ? playersMaxValue : null,
          latency: online ? latencyValue : null,
          motd,
          version,
        },
      });

      await tx.server.update({
        where: { id: job.serverId },
        data: {
          isOnline: online,
          latencyMs: online ? latencyValue : null,
          playersOnline: online ? playersOnlineValue : null,
          playersMax: online ? playersMaxValue : null,
          playersLastUpdatedAt: online ? now : null,
        },
      });

      const [totalSamples, onlineSamples] = await Promise.all([
        tx.serverPingSample.count({
          where: { serverId: job.serverId, timestamp: { gte: uptimeStart } },
        }),
        tx.serverPingSample.count({
          where: { serverId: job.serverId, timestamp: { gte: uptimeStart }, online: true },
        }),
      ]);
      const uptimePercent =
        totalSamples === 0 ? 0 : Number(((onlineSamples / totalSamples) * 100).toFixed(1));

      await tx.serverStats.upsert({
        where: { serverId: job.serverId },
        create: {
          serverId: job.serverId,
          rankCurrent: 1,
          rankDelta24h: 0,
          rankBest: 1,
          votesLast24h: 0,
          votesLast7d: 0,
          votesMonthToDate: 0,
          votesTotal: 0,
          playersOnline: online ? playersOnlineValue : 0,
          playersMax: online ? playersMaxValue : 0,
          playersLastUpdatedAt: online ? now : null,
          uptimePercent,
          sparkline: [],
          latencyMs: online ? latencyValue : 0,
          lastPingAt: now,
        },
        update: {
          playersOnline: online ? playersOnlineValue : 0,
          playersMax: online ? playersMaxValue : 0,
          playersLastUpdatedAt: online ? now : null,
          uptimePercent,
          latencyMs: online ? latencyValue : 0,
          lastPingAt: now,
        },
      });

      await tx.serverPingSample.deleteMany({
        where: {
          serverId: job.serverId,
          timestamp: { lt: retentionStart },
        },
      });
    });

    Logger.info(
      {
        ...context,
        online,
        playersOnline: online ? playersOnlineValue : null,
        playersMax: online ? playersMaxValue : null,
        latency: online ? latencyValue : null,
      },
      'Server ping recorded',
    );

    return {
      online,
      latency: online ? latencyValue : null,
      playersOnline: online ? playersOnlineValue : null,
      playersMax: online ? playersMaxValue : null,
    };
  }

  return { ping };
}

async function resolvePingTarget(
  job: ServerPingJob,
): Promise<{ host: string; port: number } | null> {
  const baseOptions = {
    label: 'Server ping probe',
    allowIpv6: ALLOW_IPV6,
  } as const;

  try {
    const target = await validateOutboundTarget(job.host, job.port, baseOptions);
    return {
      host: target.host,
      port: target.port,
    };
  } catch (error) {
    if (
      job.edition === 'java' &&
      error instanceof UnsafeEndpointError &&
      error.reason === 'resolve_failed'
    ) {
      const srvTarget = await resolveJavaSrvTarget(job.host);
      if (srvTarget) {
        try {
          const validated = await validateOutboundTarget(srvTarget.host, srvTarget.port, {
            ...baseOptions,
            label: 'Server ping probe (SRV)',
          });
          Logger.info(
            {
              host: job.host,
              port: job.port,
              resolvedHost: validated.host,
              resolvedPort: validated.port,
            },
            'Resolved server ping target via SRV record',
          );
          return {
            host: validated.host,
            port: validated.port,
          };
        } catch (srvError) {
          Logger.warn(
            { err: srvError, host: job.host, srvHost: srvTarget.host, srvPort: srvTarget.port },
            'Server ping SRV target validation failed',
          );
        }
      }
    }

    Logger.warn(
      { err: error, serverId: job.serverId, host: job.host, port: job.port, edition: job.edition },
      'Server ping target validation failed',
    );
    return null;
  }
}

async function resolveJavaSrvTarget(host: string): Promise<{ host: string; port: number } | null> {
  const normalizedHost = host.trim();
  if (!normalizedHost || isIP(normalizedHost) !== 0) {
    return null;
  }
  const query = `_minecraft._tcp.${normalizedHost}`;
  try {
    const records = await resolveSrv(query);
    if (!records || records.length === 0) {
      return null;
    }
    const [selected] = [...records].sort(
      (left, right) => left.priority - right.priority || right.weight - left.weight,
    );
    if (!selected) {
      return null;
    }
    const resolvedHost = selected.name.trim().replace(/\.$/, '');
    if (!resolvedHost) {
      return null;
    }
    return {
      host: resolvedHost,
      port: selected.port,
    };
  } catch {
    return null;
  }
}

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function extractPlayers(response: unknown): { online: number | null; max: number | null } {
  if (!response || typeof response !== 'object') {
    return { online: null, max: null };
  }
  const data = response as {
    players?: { online?: number; max?: number };
    onlinePlayers?: number;
    maxPlayers?: number;
  };
  const online =
    typeof data.players === 'object' && data.players
      ? Number(data.players.online ?? data.onlinePlayers ?? NaN)
      : Number(data.onlinePlayers ?? NaN);
  const max =
    typeof data.players === 'object' && data.players
      ? Number(data.players.max ?? data.maxPlayers ?? NaN)
      : Number(data.maxPlayers ?? NaN);
  return {
    online: Number.isFinite(online) ? online : null,
    max: Number.isFinite(max) ? max : null,
  };
}

function extractLatency(response: unknown): number | null {
  if (!response || typeof response !== 'object') {
    return null;
  }
  const data = response as { roundTripLatency?: number; latency?: number; ping?: number };
  const latency = data.roundTripLatency ?? data.latency ?? data.ping ?? (Number.NaN as number);
  return Number.isFinite(latency) ? latency : null;
}

function extractMotd(response: unknown): string | null {
  if (!response || typeof response !== 'object') {
    return null;
  }
  const data = response as {
    motd?: string | { clean?: string | string[]; raw?: string | string[] };
  };
  if (typeof data.motd === 'string') {
    return data.motd;
  }
  if (data.motd && typeof data.motd === 'object') {
    const motd = data.motd;
    if (typeof motd.clean === 'string') {
      return motd.clean;
    }
    if (Array.isArray(motd.clean)) {
      return motd.clean.join(' ');
    }
    if (typeof motd.raw === 'string') {
      return motd.raw;
    }
    if (Array.isArray(motd.raw)) {
      return motd.raw.join(' ');
    }
  }
  return null;
}

function extractVersion(response: unknown): string | null {
  if (!response || typeof response !== 'object') {
    return null;
  }
  const data = response as { version?: { name?: string; nameRaw?: string }; versionName?: string };
  if (data.version && typeof data.version.name === 'string') {
    return data.version.name;
  }
  if (data.version && typeof data.version.nameRaw === 'string') {
    return data.version.nameRaw;
  }
  if (typeof data.versionName === 'string') {
    return data.versionName;
  }
  return null;
}
