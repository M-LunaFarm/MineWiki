export interface ServerWikiIdentity {
  readonly serverName: string;
  readonly host: string | null;
}

export interface VoteServerIdentity {
  readonly name: string;
  readonly joinHost: string;
}

export function serverWikiIdentityConflicts(
  wiki: ServerWikiIdentity,
  server: VoteServerIdentity,
): boolean {
  const wikiName = normalizeServerIdentityValue(wiki.serverName);
  const serverName = normalizeServerIdentityValue(server.name);
  const wikiHost = normalizeServerHost(wiki.host);
  const serverHost = normalizeServerHost(server.joinHost);
  return wikiName.length > 0
    && serverName.length > 0
    && wikiHost.length > 0
    && serverHost.length > 0
    && wikiName !== serverName
    && wikiHost !== serverHost;
}

function normalizeServerIdentityValue(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function normalizeServerHost(value: string | null): string {
  if (!value) return '';
  return normalizeServerIdentityValue(value).replace(/\.+$/u, '');
}
