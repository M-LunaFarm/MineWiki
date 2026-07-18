import { ThrottlerStorageService, type ThrottlerStorage } from '@nestjs/throttler';
import type { ConfigService } from '@minewiki/config';
import { RedisThrottlerStorage } from './redis-throttler-storage';

type RateLimitConfig = Pick<ConfigService, 'get' | 'getOptional'>;

export async function createRateLimitStorage(config: RateLimitConfig): Promise<ThrottlerStorage> {
  const redisUrl = config.getOptional('REDIS_URL');
  const environment = config.get('NODE_ENV', 'development');
  if (!redisUrl) {
    if (environment === 'production') {
      throw new Error('REDIS_URL is required for distributed production rate limits');
    }
    return new SecondsBasedThrottlerStorage(new ThrottlerStorageService());
  }

  const storage = new RedisThrottlerStorage(redisUrl);
  await storage.connect();
  return new SecondsBasedThrottlerStorage(storage);
}

/**
 * MineWiki throttle declarations use seconds. Nest Throttler v6 passes raw
 * numeric TTLs to storage as milliseconds, so conversion belongs at this one
 * application boundary rather than at every controller decorator.
 */
export class SecondsBasedThrottlerStorage implements ThrottlerStorage {
  constructor(private readonly delegate: ThrottlerStorage) {}

  increment(
    key: string,
    ttlSeconds: number,
    limit: number,
    blockDurationSeconds: number,
    throttlerName: string,
  ) {
    return this.delegate.increment(
      key,
      secondsToMilliseconds(ttlSeconds),
      limit,
      secondsToMilliseconds(blockDurationSeconds),
      throttlerName,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    const lifecycle = this.delegate as ThrottlerStorage & {
      onApplicationShutdown?: () => void | Promise<void>;
    };
    await lifecycle.onApplicationShutdown?.();
  }
}

function secondsToMilliseconds(value: number): number {
  return Math.max(1, Math.trunc(value * 1_000));
}
