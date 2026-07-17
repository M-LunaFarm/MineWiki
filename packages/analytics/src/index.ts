import { Logger } from '@minewiki/logger';

export type AnalyticsEventName =
  | 'login.click'
  | 'auth.oauth.completed'
  | 'minecraft.verification.completed'
  | 'minecraft.verification.failed'
  | 'minecraft.verification.revoked'
  | 'minecraft.verification.primary_changed'
  | 'discord.verify.session.created'
  | 'discord.verify.completed'
  | 'discord.verify.revoked'
  | 'plugin.sync.received'
  | 'vote.submitted'
  | 'review.submitted';

export interface AnalyticsEventPayloadMap {
  'login.click': {
    provider: 'discord' | 'naver' | 'email';
  };
  'auth.oauth.completed': {
    provider: 'discord' | 'naver';
    success: boolean;
    error?: string;
  };
  'minecraft.verification.completed': {
    userId: string;
    uuid: string;
  };
  'minecraft.verification.failed': {
    userId: string;
    reason: string;
  };
  'minecraft.verification.revoked': {
    userId: string;
    removed: boolean;
  };
  'minecraft.verification.primary_changed': {
    userId: string;
    uuid: string;
  };
  'discord.verify.session.created': {
    sessionId: string;
    guildId: string;
    requesterDiscordId: string;
  };
  'discord.verify.completed': {
    sessionId: string;
    accountId: string;
    discordUserId: string;
    minecraftUuid: string;
  };
  'discord.verify.revoked': {
    guildId: string;
    discordUserId: string;
  };
  'plugin.sync.received': {
    serverId?: string;
    minecraftUuid: string;
    action: string;
  };
  'vote.submitted': {
    serverId: string;
    username: string;
    voterKey: string;
    ipAddress?: string;
  };
  'review.submitted': {
    serverId: string;
    reviewId: string;
    rating: number;
    tags: readonly string[];
    author: string;
  };
}

export type AnalyticsEvent<Name extends AnalyticsEventName = AnalyticsEventName> = {
  name: Name;
  timestamp: string;
  payload: AnalyticsEventPayloadMap[Name];
};

export type AnalyticsListener = (event: AnalyticsEvent) => void | Promise<void>;

const listeners = new Set<AnalyticsListener>();

export function registerAnalyticsListener(listener: AnalyticsListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function trackEvent<Name extends AnalyticsEventName>(
  name: Name,
  payload: AnalyticsEventPayloadMap[Name]
): Promise<void> {
  const event: AnalyticsEvent<Name> = {
    name,
    timestamp: new Date().toISOString(),
    payload
  };
  Logger.info({ event }, 'Analytics event emitted');

  for (const listener of listeners) {
    try {
      await listener(event);
    } catch (error) {
      Logger.error({ err: error }, 'Analytics listener threw an error');
    }
  }
}
