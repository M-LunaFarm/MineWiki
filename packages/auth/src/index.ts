import { z } from 'zod';

export const MINEWIKI_SESSION_COOKIE = 'mw_session';
export const MINEWIKI_LEGACY_SESSION_COOKIE = 'mw_legacy_session';
export const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

export const canonicalAccountIdSchema = z.string().uuid();

export const wikiAccountMappingSchema = z.object({
  accountId: canonicalAccountIdSchema,
  wikiUserId: z.number().int().positive(),
});

export type WikiAccountMapping = z.infer<typeof wikiAccountMappingSchema>;

export function buildMinecraftAccountReturnPath(path = '/me'): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `/minecraft/callback?returnTo=${encodeURIComponent(normalized)}`;
}
