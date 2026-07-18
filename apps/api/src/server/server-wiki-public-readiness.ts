import { serverWikiIdentityConflicts } from './server-wiki-identity';

export interface PublicServerWikiSpaceLink {
  readonly id: bigint;
  readonly status: string;
  readonly spaceType: string;
  readonly rootPageId?: bigint | null;
  readonly rootNamespaceCode?: string;
}

export interface PublicServerWikiLink {
  readonly spaceId: bigint;
  readonly voteServerId: string | null;
  readonly slug: string;
  readonly status: string;
  readonly publicationStatus: string;
  readonly serverName: string;
  readonly host: string | null;
}

export interface PublicRankedServerLink {
  readonly id: string;
  readonly listingStatus: string;
  readonly wikiSpaceId: bigint | null;
  readonly wikiPageId: bigint | null;
  readonly wikiSlug: string | null;
  readonly name: string;
  readonly joinHost: string;
}

export function hasCanonicalPublicServerWikiParent(input: {
  readonly space: PublicServerWikiSpaceLink;
  readonly wiki: PublicServerWikiLink;
  readonly server: PublicRankedServerLink | null | undefined;
}): boolean {
  const { space, wiki, server } = input;
  return wiki.status === 'active'
    && wiki.publicationStatus === 'published'
    && wiki.voteServerId !== null
    && server !== null
    && server !== undefined
    && server.id === wiki.voteServerId
    && server.listingStatus === 'active'
    && space.status === 'active'
    && space.spaceType === 'server_wiki'
    && space.rootNamespaceCode === 'server'
    && space.rootPageId !== null
    && space.rootPageId !== undefined
    && wiki.spaceId === space.id
    && server.wikiSpaceId === space.id
    && server.wikiPageId === space.rootPageId
    && server.wikiSlug === wiki.slug
    && !serverWikiIdentityConflicts(wiki, server);
}
