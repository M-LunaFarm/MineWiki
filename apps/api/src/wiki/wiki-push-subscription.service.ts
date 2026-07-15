import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { Prisma } from '@prisma/client';
import { createHash, ECDH } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { encryptAppSecret } from '../common/secret-codec';
import type { SessionPayload } from '../session/session.service';
import { WikiProfileService } from './wiki-profile.service';

const MAX_ACTIVE_DEVICES = 8;
const subscriptionSchema = z.object({
  endpoint: z.string().trim().min(1).max(2048),
  expirationTime: z.number().int().positive().nullable().optional(),
  keys: z.object({
    p256dh: z.string().trim().min(80).max(120),
    auth: z.string().trim().min(16).max(40),
  }).strict(),
}).strict();

const allowedPushHosts = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
];

@Injectable()
export class WikiPushSubscriptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: WikiProfileService,
    private readonly config: ConfigService,
  ) {}

  async status(session: SessionPayload) {
    const publicKey = this.publicKey();
    const subscription = await this.prisma.wikiPushSubscription.findUnique({
      where: { sessionId: session.sessionId },
      select: { disabledAt: true, expirationTime: true, endpointHash: true },
    });
    return {
      enabled: Boolean(publicKey),
      subscribed: Boolean(subscription && !subscription.disabledAt),
      publicKey,
      publicKeyFingerprint: publicKey ? createHash('sha256').update(publicKey).digest('hex').slice(0, 16) : null,
      endpointFingerprint: subscription?.endpointHash.slice(0, 16) ?? null,
      expirationTime: subscription?.expirationTime?.toISOString() ?? null,
      maxDevices: MAX_ACTIVE_DEVICES,
    };
  }

  async register(session: SessionPayload, input: unknown) {
    const publicKey = this.publicKey();
    if (!publicKey) throw new ConflictException('브라우저 알림이 아직 활성화되지 않았습니다.');
    const parsed = subscriptionSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('브라우저 알림 구독 정보가 올바르지 않습니다.');
    const endpoint = validatePushEndpoint(parsed.data.endpoint);
    validateSubscriptionKeys(parsed.data.keys.p256dh, parsed.data.keys.auth);
    const expirationTime = parsed.data.expirationTime
      ? new Date(parsed.data.expirationTime)
      : null;
    if (expirationTime && expirationTime.getTime() <= Date.now()) {
      throw new BadRequestException('만료된 브라우저 알림 구독은 등록할 수 없습니다.');
    }
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    if (profile.status !== 'active') throw new ConflictException('활성 위키 사용자만 브라우저 알림을 받을 수 있습니다.');

    const endpointHash = createHash('sha256').update(endpoint).digest('hex');
    const encrypted = {
      endpointCiphertext: requireEncrypted(endpoint),
      p256dhCiphertext: requireEncrypted(parsed.data.keys.p256dh),
      authCiphertext: requireEncrypted(parsed.data.keys.auth),
    };
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        const [current, foundEndpoint] = await Promise.all([
          tx.wikiPushSubscription.findUnique({ where: { sessionId: session.sessionId }, select: { id: true } }),
          tx.wikiPushSubscription.findUnique({
            where: { endpointHash },
            select: {
              id: true,
              profileId: true,
              disabledAt: true,
              expirationTime: true,
              session: { select: { accountId: true, expiresAt: true, account: { select: { lifecycleStatus: true } } } },
              profile: { select: { accountId: true, status: true } },
            },
          }),
        ]);
        let existingEndpoint = foundEndpoint;
        const existingEndpointIsStale = existingEndpoint && (
          existingEndpoint.disabledAt !== null
          || (existingEndpoint.expirationTime !== null && existingEndpoint.expirationTime <= now)
          || existingEndpoint.session.expiresAt <= now
          || existingEndpoint.session.account.lifecycleStatus !== 'active'
          || existingEndpoint.profile.status !== 'active'
          || existingEndpoint.profile.accountId !== existingEndpoint.session.accountId
        );
        if (existingEndpointIsStale) {
          await tx.wikiPushSubscription.deleteMany({ where: { id: existingEndpoint.id } });
          existingEndpoint = null;
        }
        if (existingEndpoint && existingEndpoint.profileId !== profile.id) {
          throw new ConflictException('이 브라우저 알림 구독은 다른 계정에 연결되어 있습니다. 해당 계정에서 먼저 로그아웃해 주세요.');
        }
        const activeDevices = await tx.wikiPushSubscription.count({
          where: {
            profileId: profile.id,
            disabledAt: null,
            id: current ? { not: current.id } : undefined,
          },
        });
        if (!current && activeDevices >= MAX_ACTIVE_DEVICES) {
          throw new ConflictException(`브라우저 알림은 계정당 최대 ${MAX_ACTIVE_DEVICES}개 기기에서 사용할 수 있습니다.`);
        }
        if (existingEndpoint && existingEndpoint.id !== current?.id) {
          await tx.wikiPushSubscription.delete({ where: { id: existingEndpoint.id } });
        }
        await tx.wikiPushSubscription.upsert({
          where: { sessionId: session.sessionId },
          create: {
            sessionId: session.sessionId,
            profileId: profile.id,
            endpointHash,
            ...encrypted,
            expirationTime,
          },
          update: {
            profileId: profile.id,
            endpointHash,
            ...encrypted,
            expirationTime,
            disabledAt: null,
            failureCount: 0,
            lastFailureAt: null,
          },
        });
      });
    } catch (error) {
      if (error instanceof ConflictException || error instanceof BadRequestException) throw error;
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('브라우저 알림 구독이 이미 다른 세션에서 사용 중입니다.');
      }
      throw error;
    }
    return this.status(session);
  }

  async unregister(session: SessionPayload): Promise<{ removed: boolean }> {
    const result = await this.prisma.wikiPushSubscription.deleteMany({
      where: { sessionId: session.sessionId },
    });
    return { removed: result.count > 0 };
  }

  private publicKey(): string | null {
    const enabled = ['1', 'true', 'yes', 'on'].includes(
      this.config.getOptional('WEB_PUSH_ENABLED')?.trim().toLowerCase() ?? '',
    );
    return enabled ? this.config.getOptional('VAPID_PUBLIC_KEY')?.trim() || null : null;
  }
}

export function validatePushEndpoint(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new BadRequestException('브라우저 알림 endpoint가 올바르지 않습니다.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) {
    throw new BadRequestException('안전한 HTTPS 브라우저 알림 endpoint만 사용할 수 있습니다.');
  }
  const host = url.hostname.toLowerCase();
  const allowed = allowedPushHosts.some((candidate) => host === candidate)
    || host.endsWith('.notify.windows.com');
  if (!allowed) throw new BadRequestException('지원하지 않는 브라우저 알림 제공자입니다.');
  return url.toString();
}

export function validateSubscriptionKeys(p256dh: string, auth: string): void {
  const publicKey = decodeBase64Url(p256dh);
  const authSecret = decodeBase64Url(auth);
  if (publicKey.length !== 65 || publicKey[0] !== 4 || authSecret.length !== 16) {
    throw new BadRequestException('브라우저 알림 암호화 키가 올바르지 않습니다.');
  }
  try {
    ECDH.convertKey(publicKey, 'prime256v1');
  } catch {
    throw new BadRequestException('브라우저 알림 공개키가 P-256 곡선에 속하지 않습니다.');
  }
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new BadRequestException('브라우저 알림 암호화 키가 올바르지 않습니다.');
  try { return Buffer.from(value, 'base64url'); } catch { throw new BadRequestException('브라우저 알림 암호화 키가 올바르지 않습니다.'); }
}

function requireEncrypted(value: string): string {
  const encrypted = encryptAppSecret(value);
  if (!encrypted || !encrypted.startsWith('enc:')) throw new Error('브라우저 알림 구독 암호화에 실패했습니다.');
  return encrypted;
}
