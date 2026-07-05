export const CANONICAL_ACCOUNT_MODEL = 'Account';
export const WIKI_ACCOUNT_ID_COLUMN = 'account_id';
export const WIKI_SERVER_VOTE_ID_COLUMN = 'vote_server_id';

export const DISCORD_VERIFY_STATUSES = [
  'pending',
  'linked',
  'sync_pending',
  'synced',
  'failed',
  'expired',
] as const;

export type DiscordVerifyStatus = (typeof DISCORD_VERIFY_STATUSES)[number];

export const PLUGIN_SYNC_ACTIONS = [
  'minecraft_verified',
  'discord_linked',
  'role_synced',
  'nickname_synced',
] as const;

export type PluginSyncAction = (typeof PLUGIN_SYNC_ACTIONS)[number];

export interface ServerWikiMapping {
  readonly voteServerId: string;
  readonly wikiSpaceId?: bigint | null;
  readonly wikiPageId?: bigint | null;
  readonly wikiSlug?: string | null;
}
