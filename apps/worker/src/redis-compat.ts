export function assertSupportedQueueServer(serverInfo: string): void {
  if (/^dragonfly_version:/im.test(serverInfo)) {
    throw new Error(
      'Dragonfly is not supported for BullMQ queues in this deployment. Configure REDIS_URL to an official Redis 7+ server.',
    );
  }

  const redisVersion = serverInfo.match(/^redis_version:([^\r\n]+)/im)?.[1]?.trim();
  if (!redisVersion) {
    throw new Error('Unable to identify the Redis server used for BullMQ queues.');
  }
  const major = Number.parseInt(redisVersion.split('.')[0] ?? '', 10);
  if (!Number.isFinite(major) || major < 7) {
    throw new Error(`BullMQ queues require Redis 7 or newer; detected ${redisVersion}.`);
  }
}
