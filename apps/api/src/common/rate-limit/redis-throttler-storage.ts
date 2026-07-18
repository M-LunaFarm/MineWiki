import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';

const INCREMENT_SCRIPT = `
local clock = redis.call('TIME')
local now_ms = (tonumber(clock[1]) * 1000) + math.floor(tonumber(clock[2]) / 1000)
local ttl_ms = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local block_ms = tonumber(ARGV[3])
local block_until = tonumber(redis.call('HGET', KEYS[1], 'block_until') or '0')

if block_until > 0 and block_until <= now_ms then
  redis.call('DEL', KEYS[2])
  redis.call('HDEL', KEYS[1], 'block_until')
  block_until = 0
end

redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now_ms - ttl_ms)

if block_until > now_ms then
  local blocked_hits = tonumber(redis.call('ZCARD', KEYS[2]))
  local oldest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
  local expire_ms = 0
  if oldest[2] then
    expire_ms = math.max(0, tonumber(oldest[2]) + ttl_ms - now_ms)
  end
  return {blocked_hits, math.ceil(expire_ms / 1000), 1, math.ceil((block_until - now_ms) / 1000)}
end

local sequence = redis.call('HINCRBY', KEYS[1], 'sequence', 1)
redis.call('ZADD', KEYS[2], now_ms, tostring(now_ms) .. ':' .. tostring(sequence))
local total_hits = tonumber(redis.call('ZCARD', KEYS[2]))

if total_hits > limit then
  block_until = now_ms + block_ms
  redis.call('HSET', KEYS[1], 'block_until', block_until)
end

local oldest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
local expire_ms = ttl_ms
if oldest[2] then
  expire_ms = math.max(0, tonumber(oldest[2]) + ttl_ms - now_ms)
end
local retention_ms = math.max(ttl_ms, block_ms) + 1000
redis.call('PEXPIRE', KEYS[1], retention_ms)
redis.call('PEXPIRE', KEYS[2], retention_ms)

local is_blocked = 0
local block_expire_seconds = 0
if block_until > now_ms then
  is_blocked = 1
  block_expire_seconds = math.ceil((block_until - now_ms) / 1000)
end
return {total_hits, math.ceil(expire_ms / 1000), is_blocked, block_expire_seconds}
`;

export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly redis: Redis;

  constructor(
    redisUrl: string,
    private readonly namespace = 'minewiki:rate-limit',
  ) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 1_500,
      commandTimeout: 1_500,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: (attempt) => Math.min(attempt * 100, 1_000),
    });
    this.redis.on('error', () => undefined);
  }

  async connect(): Promise<void> {
    if (this.redis.status === 'wait' || this.redis.status === 'end') {
      await this.redis.connect();
    }
    await this.redis.ping();
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
  ): Promise<ThrottlerStorageRecord> {
    const hashTag = `{${key}}`;
    const result = await this.redis.eval(
      INCREMENT_SCRIPT,
      2,
      `${this.namespace}:${hashTag}:state`,
      `${this.namespace}:${hashTag}:hits`,
      normalizeDuration(ttl),
      normalizeLimit(limit),
      normalizeDuration(blockDuration),
    );
    if (!Array.isArray(result) || result.length !== 4) {
      throw new Error('Redis returned an invalid rate-limit result');
    }
    const [totalHits, timeToExpire, isBlocked, timeToBlockExpire] = result.map(Number);
    if ([totalHits, timeToExpire, isBlocked, timeToBlockExpire].some(Number.isNaN)) {
      throw new Error('Redis returned a malformed rate-limit result');
    }
    return {
      totalHits,
      timeToExpire,
      isBlocked: isBlocked === 1,
      timeToBlockExpire,
    };
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'end') return;
    if (this.redis.status === 'ready') {
      await this.redis.quit().catch(() => this.redis.disconnect());
      return;
    }
    this.redis.disconnect();
  }
}

function normalizeDuration(value: number): number {
  return Math.max(1, Math.trunc(value));
}

function normalizeLimit(value: number): number {
  return Math.max(0, Math.trunc(value));
}
