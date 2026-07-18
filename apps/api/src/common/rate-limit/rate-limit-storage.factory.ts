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
    return new ThrottlerStorageService();
  }

  const storage = new RedisThrottlerStorage(redisUrl);
  await storage.connect();
  return storage;
}
