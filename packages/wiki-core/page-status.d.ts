export const PUBLIC_WIKI_PAGE_STATUSES: readonly ['normal', 'active', 'published', 'protected'];
export type PublicWikiPageStatus = (typeof PUBLIC_WIKI_PAGE_STATUSES)[number];
export const PUBLIC_WIKI_PAGE_STATUS_SQL_LIST: string;
export function isPublicWikiPageStatus(status: string): status is PublicWikiPageStatus;
