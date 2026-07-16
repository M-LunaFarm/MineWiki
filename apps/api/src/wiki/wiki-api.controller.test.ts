import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { WikiApiController } from './wiki-api.controller';
import type { WikiEditService } from './wiki-edit.service';
import type { AuthenticatedWikiApiToken, WikiApiTokenService } from './wiki-api-token.service';
import type { WikiReadService } from './wiki-read.service';

const token: AuthenticatedWikiApiToken = {
  id: 'token-id',
  accountId: 'account-id',
  scopes: ['wiki:read', 'wiki:create', 'wiki:edit'],
  spaceId: '42',
  session: {
    sessionId: 'wiki-api:token-id',
    userId: 'account-id',
    tokenVersion: 1,
    isElevated: false,
    authenticatedAt: '1970-01-01T00:00:00.000Z',
  },
};

test('by-path Wiki API returns metadata only and enforces read scope and response space', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const page = {
    id: '10',
    namespace: 'server',
    spaceId: '42',
    slug: 'minewiki/rules',
    title: 'minewiki/rules',
    displayTitle: '규칙',
    pageType: 'server',
    protectionLevel: 'open',
    status: 'normal',
    updatedAt: '2026-07-16T00:00:00.000Z',
    revision: {
      id: '20', revisionNo: 3, contentHash: 'hash',
      createdAt: '2026-07-16T00:00:00.000Z', createdBy: null,
    },
    html: '<p>secret rendered payload</p>',
    links: ['main:other'],
    categories: ['test'],
    headings: [{ level: 2, title: 'heading', anchor: 'heading' }],
    redirectTarget: null,
  };
  const controller = new WikiApiController(
    {
      assertScope(...args: unknown[]) { calls.push({ method: 'scope', args }); },
      assertResponseSpace(...args: unknown[]) { calls.push({ method: 'responseSpace', args }); },
    } as unknown as WikiApiTokenService,
    { async getPageByPath(...args: unknown[]) { calls.push({ method: 'read', args }); return page; } } as unknown as WikiReadService,
    {} as WikiEditService,
  );

  const result = await controller.getPageByPath(' /server/minewiki/rules ', requestWithToken());

  assert.deepEqual(result, {
    id: '10',
    namespace: 'server',
    spaceId: '42',
    title: 'minewiki/rules',
    displayTitle: '규칙',
    revision: page.revision,
  });
  assert.equal('html' in result, false);
  assert.deepEqual(calls, [
    { method: 'scope', args: [token, 'wiki:read'] },
    { method: 'read', args: ['/server/minewiki/rules', 'account-id'] },
    { method: 'responseSpace', args: [token, '42'] },
  ]);
});

test('by-path Wiki API requires an explicit path', async () => {
  const controller = new WikiApiController(
    { assertScope() {} } as unknown as WikiApiTokenService,
    {} as WikiReadService,
    {} as WikiEditService,
  );
  await assert.rejects(
    () => controller.getPageByPath('  ', requestWithToken()),
    BadRequestException,
  );
});

test('raw Wiki API performs scope and space checks and passes the service space constraint', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const raw = { id: '20', pageId: '10', contentRaw: 'raw' };
  const controller = new WikiApiController(
    {
      assertScope(...args: unknown[]) { calls.push({ method: 'scope', args }); },
      async assertPageSpace(...args: unknown[]) { calls.push({ method: 'pageSpace', args }); },
    } as unknown as WikiApiTokenService,
    {} as WikiReadService,
    { async getRawPage(...args: unknown[]) { calls.push({ method: 'raw', args }); return raw; } } as unknown as WikiEditService,
  );

  assert.equal(await controller.getPageRaw('10', '20', requestWithToken()), raw);
  assert.deepEqual(calls, [
    { method: 'scope', args: [token, 'wiki:read'] },
    { method: 'pageSpace', args: [token, '10'] },
    { method: 'raw', args: ['10', 'account-id', '20', { allowedSpaceId: 42n }] },
  ]);
});

test('create and update Wiki APIs require idempotent execution and pass allowedSpaceId', async () => {
  const calls: Array<{ method: string; args?: unknown[]; input?: Record<string, unknown> }> = [];
  const service = {
    assertScope(...args: unknown[]) { calls.push({ method: 'scope', args }); },
    assertCreateSpace(...args: unknown[]) { calls.push({ method: 'createSpace', args }); },
    async assertPageSpace(...args: unknown[]) { calls.push({ method: 'pageSpace', args }); },
    async idempotent(input: { action: () => Promise<unknown> } & Record<string, unknown>) {
      const { action, ...rest } = input;
      calls.push({ method: 'idempotent', input: rest });
      return action();
    },
  } as unknown as WikiApiTokenService;
  const edit = {
    async resolveCreatePageTarget(...args: unknown[]) {
      calls.push({ method: 'resolveCreate', args });
      return { spaceId: 42n };
    },
    async createPage(...args: unknown[]) {
      calls.push({ method: 'create', args });
      return { pageId: '10', revisionId: '20' };
    },
    async updatePage(...args: unknown[]) {
      calls.push({ method: 'update', args });
      return { pageId: '10', revisionId: '21' };
    },
  } as unknown as WikiEditService;
  const controller = new WikiApiController(service, {} as WikiReadService, edit);
  const createBody = { namespace: 'server', title: 'minewiki/rules', contentRaw: 'rules' };
  const updateBody = { contentRaw: 'new rules', baseRevisionId: '20' };

  assert.deepEqual(
    await controller.createPage(createBody, 'create-key-123', requestWithToken()),
    { pageId: '10', revisionId: '20' },
  );
  assert.deepEqual(
    await controller.updatePage('10', updateBody, 'update-key-123', requestWithToken()),
    { pageId: '10', revisionId: '21' },
  );

  assert.deepEqual(calls, [
    { method: 'scope', args: [token, 'wiki:create'] },
    { method: 'resolveCreate', args: [createBody] },
    { method: 'createSpace', args: [token, '42'] },
    { method: 'idempotent', input: {
      tokenId: 'token-id', key: 'create-key-123', method: 'POST',
      route: '/v1/wiki/api/pages', body: createBody, responseStatus: 201,
    } },
    { method: 'create', args: [token.session, createBody, { allowedSpaceId: 42n }] },
    { method: 'scope', args: [token, 'wiki:edit'] },
    { method: 'pageSpace', args: [token, '10'] },
    { method: 'idempotent', input: {
      tokenId: 'token-id', key: 'update-key-123', method: 'PATCH',
      route: '/v1/wiki/api/pages/10', body: updateBody, responseStatus: 200,
    } },
    { method: 'update', args: [token.session, '10', updateBody, { allowedSpaceId: 42n }] },
  ]);
});

function requestWithToken(): FastifyRequest {
  return { wikiApiToken: token, headers: {} } as unknown as FastifyRequest;
}
