import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import Redis from 'ioredis';
import { PrismaService } from './common/prisma.service';

interface DependencyCheck {
  readonly status: 'ok' | 'error' | 'disabled';
  readonly latencyMs: number;
  readonly message?: string;
}

export interface ReadinessReport {
  readonly status: 'ok' | 'error';
  readonly service: 'minewiki-api';
  readonly checks: {
    readonly database: DependencyCheck;
    readonly redis: DependencyCheck;
  };
  readonly checkedAt: string;
}

@Injectable()
export class AppService implements OnModuleDestroy {
  private readonly redis?: Redis;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const redisUrl = config.getOptional('REDIS_URL');
    if (redisUrl) {
      this.redis = new Redis(redisUrl, {
        lazyConnect: true,
        connectTimeout: 1_500,
        commandTimeout: 1_500,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      this.redis.on('error', () => undefined);
    }
  }

  getHealth() {
    return {
      status: 'ok',
      service: 'minewiki-api',
      uptime: process.uptime(),
      checkedAt: new Date().toISOString()
    };
  }

  async getReadiness(): Promise<ReadinessReport> {
    const [database, redis] = await Promise.all([
      checkDependency(() => this.prisma.$queryRawUnsafe('SELECT 1')),
      this.redis
        ? checkDependency(async () => {
            if (this.redis!.status === 'wait' || this.redis!.status === 'end') {
              await this.redis!.connect();
            }
            await this.redis!.ping();
          })
        : Promise.resolve<DependencyCheck>({ status: 'disabled', latencyMs: 0 }),
    ]);

    return {
      status: database.status === 'ok' && redis.status !== 'error' ? 'ok' : 'error',
      service: 'minewiki-api',
      checks: { database, redis },
      checkedAt: new Date().toISOString(),
    };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis && this.redis.status !== 'end') {
      await this.redis.quit().catch(() => this.redis?.disconnect());
    }
  }
}

async function checkDependency(operation: () => Promise<unknown>): Promise<DependencyCheck> {
  const startedAt = Date.now();
  try {
    await withTimeout(operation(), 2_000);
    return { status: 'ok', latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      status: 'error',
      latencyMs: Date.now() - startedAt,
      message:
        error instanceof Error && error.message === 'dependency_check_timeout'
          ? 'dependency_check_timeout'
          : 'dependency_unavailable',
    };
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('dependency_check_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
