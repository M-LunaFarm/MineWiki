import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import type { MessageEvent } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import Redis from 'ioredis';
import { Observable } from 'rxjs';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';

const CHANNEL = 'minewiki:wiki:discussion:invalidate:v1';
const ACL_RECHECK_INTERVAL_MS = 10_000;
const THREAD_ID_PATTERN = /^\d{1,20}$/;
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;

interface TransportEvent {
  readonly v: 1;
  readonly source: string;
  readonly eventId: string;
  readonly threadId: string;
}

/**
 * Content-free discussion invalidation transport.
 *
 * A process always notifies its own subscribers first, so Redis being down
 * cannot break single-process live updates. Redis Pub/Sub only fans the same
 * opaque invalidation out to other API instances; clients still fetch the
 * ACL-filtered discussion detail through the normal API.
 */
@Injectable()
export class WikiDiscussionLiveService implements OnModuleDestroy {
  private readonly instanceId = randomUUID();
  private readonly local = new EventEmitter();
  private readonly publisher?: Redis;
  private readonly subscriber?: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: WikiProfileService,
    private readonly permissions: WikiPermissionService,
    config: ConfigService
  ) {
    this.local.setMaxListeners(0);
    const redisUrl = config.getOptional('REDIS_URL');
    if (!redisUrl) return;

    const options = {
      connectTimeout: 1_500,
      commandTimeout: 1_500,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: (attempt: number) => Math.min(attempt * 250, 5_000)
    } as const;
    this.publisher = new Redis(redisUrl, options);
    this.subscriber = new Redis(redisUrl, options);
    this.publisher.on('error', () => undefined);
    this.subscriber.on('error', () => undefined);
    this.subscriber.on('ready', () => {
      void this.subscriber?.subscribe(CHANNEL).catch(() => undefined);
    });
    this.subscriber.on('message', (channel, raw) => {
      if (channel === CHANNEL) this.acceptTransportMessage(raw);
    });
  }

  async openEvents(
    threadIdValue: string,
    session?: SessionPayload | null,
    _lastEventId?: string
  ): Promise<Observable<MessageEvent>> {
    // Pub/Sub invalidations are not replayable. Any Last-Event-ID therefore
    // intentionally converges through the unconditional initial sync below.
    void _lastEventId;
    const threadId = parseThreadId(threadIdValue);
    await this.assertCanRead(threadId, session);

    return new Observable<MessageEvent>((subscriber) => {
      let closed = false;
      let checking = false;
      let successfulChecks = 0;
      const onInvalidate = (eventId: string) => {
        subscriber.next({ type: 'invalidate', id: eventId, data: {} });
      };
      this.local.on(threadId.toString(), onInvalidate);
      subscriber.next({ type: 'sync', id: randomUUID(), retry: 3_000, data: {} });

      const timer = setInterval(() => {
        if (checking || closed) return;
        checking = true;
        void this.assertCanRead(threadId, session)
          .then(() => {
            if (closed) return;
            successfulChecks += 1;
            subscriber.next({ type: 'heartbeat', data: {} });
            // Redis Pub/Sub is intentionally ephemeral. A periodic content-free
            // sync guarantees eventual refetch even if an invalidation was lost
            // during a Redis failover while the SSE connection stayed alive.
            if (successfulChecks % 3 === 0) {
              subscriber.next({ type: 'sync', id: randomUUID(), data: {} });
            }
          })
          .catch(() => {
            if (!closed) subscriber.complete();
          })
          .finally(() => {
            checking = false;
          });
      }, ACL_RECHECK_INTERVAL_MS);

      return () => {
        closed = true;
        clearInterval(timer);
        this.local.off(threadId.toString(), onInvalidate);
      };
    });
  }

  publish(threadIdValue: bigint | string): void {
    const threadId = typeof threadIdValue === 'bigint'
      ? threadIdValue.toString()
      : parseThreadId(threadIdValue).toString();
    const event: TransportEvent = {
      v: 1,
      source: this.instanceId,
      eventId: randomUUID(),
      threadId
    };

    // Local delivery is deliberate even when Redis exists: it is the outage
    // fallback and avoids waiting on network I/O after a committed mutation.
    this.local.emit(threadId, event.eventId);
    void this.publisher?.publish(CHANNEL, JSON.stringify(event)).catch(() => undefined);
  }

  /** Package-visible for transport validation tests. */
  acceptTransportMessage(raw: string): void {
    const event = parseTransportEvent(raw);
    if (!event || event.source === this.instanceId) return;
    this.local.emit(event.threadId, event.eventId);
  }

  async onModuleDestroy(): Promise<void> {
    this.local.removeAllListeners();
    await Promise.all([
      closeRedis(this.publisher),
      closeRedis(this.subscriber)
    ]);
  }

  private async assertCanRead(threadId: bigint, session?: SessionPayload | null): Promise<void> {
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id: threadId } });
    if (!thread || thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } });
    if (!page) throw new NotFoundException('Wiki discussion thread not found.');
    const actor = session
      ? this.permissions.actorFromSession(session, await this.profiles.ensureWikiProfile(session.userId))
      : null;
    await this.permissions.assertCanReadThread({
      accountId: session?.userId ?? null,
      actor,
      thread,
      page
    });
  }
}

function parseThreadId(value: string): bigint {
  if (!THREAD_ID_PATTERN.test(value)) throw new NotFoundException('Wiki discussion thread not found.');
  const id = BigInt(value);
  if (id > MAX_UNSIGNED_BIGINT) throw new NotFoundException('Wiki discussion thread not found.');
  return id;
}

function parseTransportEvent(raw: string): TransportEvent | null {
  if (raw.length > 512) return null;
  try {
    const value = JSON.parse(raw) as Partial<TransportEvent>;
    if (
      value.v !== 1 ||
      typeof value.source !== 'string' || value.source.length < 1 || value.source.length > 64 ||
      typeof value.eventId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.eventId) ||
      typeof value.threadId !== 'string' || !THREAD_ID_PATTERN.test(value.threadId) || BigInt(value.threadId) > MAX_UNSIGNED_BIGINT
    ) return null;
    return value as TransportEvent;
  } catch {
    return null;
  }
}

async function closeRedis(client?: Redis): Promise<void> {
  if (!client || client.status === 'end') return;
  if (client.status === 'ready') {
    await client.quit().catch(() => client.disconnect());
  } else {
    client.disconnect();
  }
}
