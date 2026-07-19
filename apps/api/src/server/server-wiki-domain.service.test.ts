import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { normalizeCustomHostname, ServerWikiDomainService, type ServerWikiDomainDnsResolver } from './server-wiki-domain.service';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';

test('custom hostnames normalize IDN and reject IPs, public suffixes, and MineWiki hosts', () => {
  assert.equal(normalizeCustomHostname(' Docs.Example.COM. '), 'docs.example.com');
  assert.equal(normalizeCustomHostname('문서.예시.한국'), 'xn--z92bu1i.xn--vv4b11d.xn--3e0b707e');
  for (const value of ['127.0.0.1', 'localhost', 'https://docs.example.com', 'co.uk', 'minewiki.kr', 'docs.minewiki.kr']) {
    assert.throws(() => normalizeCustomHostname(value), BadRequestException);
  }
});

test('configuration returns the DNS token once while persisting only its digest', async () => {
  const fixture = domainFixture();
  const service = new ServerWikiDomainService(fixture.prisma as never, fixture.dns);

  const configured = await service.configure(SERVER_ID, 'docs.example.com', 0, 'account-1');

  assert.match(configured.challenge.value ?? '', /^minewiki-verification=[A-Za-z0-9_-]{40,}$/u);
  assert.equal(configured.version, 1);
  assert.equal(fixture.domain?.hostname, 'docs.example.com');
  assert.match(fixture.domain?.verificationTokenHash ?? '', /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(fixture.domain?.verificationTokenHash ?? '', /minewiki-verification/u);
  assert.equal((await service.get(SERVER_ID))?.challenge.value, null);
  assert.deepEqual(fixture.audit.map((event) => event.action), ['server.wiki_domain.configure']);
});

test('verification requires both exact TXT ownership and MineWiki routing before activation', async () => {
  const fixture = domainFixture();
  const service = new ServerWikiDomainService(fixture.prisma as never, fixture.dns);
  const configured = await service.configure(SERVER_ID, 'docs.example.com', 0, 'account-1');

  await assert.rejects(service.verify(SERVER_ID, configured.version, 'account-1'), ConflictException);
  fixture.txt = [[configured.challenge.value!]];
  fixture.cnames = ['domains.minewiki.kr.'];
  const verified = await service.verify(SERVER_ID, configured.version, 'account-1');

  assert.equal(verified.status, 'active');
  assert.equal(verified.version, 2);
  assert.ok(verified.verifiedAt);
  await assert.rejects(service.verify(SERVER_ID, configured.version, 'account-1'), ConflictException);
});

test('public domain routing exposes only a canonical active published release', async () => {
  const fixture = domainFixture();
  const service = new ServerWikiDomainService(fixture.prisma as never, fixture.dns);
  const configured = await service.configure(SERVER_ID, 'docs.example.com', 0, 'account-1');
  fixture.txt = [[configured.challenge.value!]];
  fixture.cnames = ['domains.minewiki.kr'];
  await service.verify(SERVER_ID, 1, 'account-1');

  assert.deepEqual(await service.resolveActiveHost('DOCS.EXAMPLE.COM.'), {
    hostname: 'docs.example.com', siteSlug: 'example', bindingVersion: 2,
  });
  fixture.wiki.publicationStatus = 'draft';
  await assert.rejects(service.resolveActiveHost('docs.example.com'), NotFoundException);
});

function domainFixture() {
  const server = {
    id: SERVER_ID,
    wikiSpaceId: 10n,
    wikiPageId: 100n,
    wikiSlug: 'docs',
    listingStatus: 'active',
    name: 'Example',
    joinHost: 'play.example.com',
  };
  const space = { id: 10n, status: 'active', spaceType: 'server_wiki', rootNamespaceCode: 'server', rootPageId: 100n };
  const wiki = {
    id: 20n,
    spaceId: 10n,
    voteServerId: SERVER_ID,
    slug: 'docs',
    siteSlug: 'example',
    status: 'active',
    publicationStatus: 'published',
    publishedReleaseId: 50n,
    serverName: 'Example',
    host: 'play.example.com',
    space,
  };
  let domain: Record<string, unknown> | null = null;
  const audit: Array<{ action: string }> = [];
  let txt: readonly (readonly string[])[] = [];
  let cnames: readonly string[] = [];
  const store = {
    async $queryRaw() { return []; },
    server: { async findUnique() { return server; } },
    serverWiki: { async findUnique() { return wiki; } },
    serverWikiDomain: {
      async findUnique(input: { include?: unknown }) {
        if (!domain) return null;
        return input.include ? { ...domain, serverWiki: wiki } : domain;
      },
      async findUniqueOrThrow() { if (!domain) throw new Error('missing'); return domain; },
      async create(input: { data: Record<string, unknown> }) {
        domain = {
          id: 1n, verifiedAt: null, activatedAt: null, disabledAt: null, lastCheckedAt: null,
          ...input.data,
        };
        return domain;
      },
      async updateMany(input: { where: { version?: number; status?: unknown }; data: Record<string, unknown> }) {
        if (!domain || (input.where.version !== undefined && domain.version !== input.where.version)) return { count: 0 };
        if (input.where.status && domain.status === 'disabled') return { count: 0 };
        const data = { ...input.data };
        if (typeof data.version === 'object') data.version = Number(domain.version) + 1;
        domain = { ...domain, ...data };
        return { count: 1 };
      },
    },
    auditEvent: { async create(input: { data: { action: string } }) { audit.push(input.data); return input.data; } },
  };
  const prisma = {
    ...store,
    async $transaction<T>(callback: (tx: typeof store) => Promise<T>) { return callback(store); },
  };
  const dns: ServerWikiDomainDnsResolver = {
    async resolveTxt() { return txt; },
    async resolveCname() { return cnames; },
    async resolve4() { return []; },
    async resolve6() { return []; },
  };
  return {
    prisma, dns, server, wiki, audit,
    get domain() { return domain; },
    get txt() { return txt; }, set txt(value) { txt = value; },
    get cnames() { return cnames; }, set cnames(value) { cnames = value; },
  };
}
