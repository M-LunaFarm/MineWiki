import assert from 'node:assert/strict';
import test from 'node:test';
import { type ExecutionContext, NotFoundException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaService } from '../common/prisma.service';
import { runInHttpRequestContext } from '../common/http/request-context';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { WikiAclService } from './wiki-acl.service';
import { WikiController } from './wiki.controller';
import type { WikiEditService } from './wiki-edit.service';
import type { WikiProfileService } from './wiki-profile.service';
import type { WikiReadService } from './wiki-read.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiCaptchaService } from './wiki-captcha.service';

const captchaStub = { async assertVerified() {} } as WikiCaptchaService;

test('public wiki stats controller forwards an optional namespace without authentication', async () => {
  let receivedNamespace: string | undefined;
  const controller = new WikiController(
    {} as WikiProfileService,
    {
      async getPublicStats(namespace?: string) {
        receivedNamespace = namespace;
        return { pageCount: 42, namespace: 'main', generatedAt: '2026-07-16T00:00:00.000Z' };
      }
    } as unknown as WikiReadService,
    {} as WikiEditService,
    captchaStub
  );

  const response = await controller.getPublicStats('main');

  assert.equal(receivedNamespace, 'main');
  assert.equal(response.pageCount, 42);
});

test('new wiki pages require captcha before the clean mutation reaches the edit service', async () => {
  const session = { userId: 'account-1', requestIp: '192.0.2.20' } as SessionPayload;
  let captchaInput: unknown;
  let mutationInput: unknown;
  const controller = new WikiController(
    {} as WikiProfileService,
    {} as WikiReadService,
    { async createPage(receivedSession: SessionPayload, body: unknown) { mutationInput = { receivedSession, body }; return { pageId: '1' }; } } as unknown as WikiEditService,
    { async assertVerified(token: string | undefined, ip: string | undefined) { captchaInput = { token, ip }; } } as WikiCaptchaService
  );
  const request = { clientIp: '192.0.2.21' } as FastifyRequest;

  await controller.createPage({ namespace: 'main', title: '새 문서', contentRaw: '본문', captchaToken: 'verified-token' }, session, request);

  assert.deepEqual(captchaInput, { token: 'verified-token', ip: '192.0.2.21' });
  assert.deepEqual(mutationInput, { receivedSession: session, body: { namespace: 'main', title: '새 문서', contentRaw: '본문' } });
});

test('wiki move controller forwards additive destination namespace and space fields', async () => {
  const session = { userId: 'account-1' } as SessionPayload;
  let mutationInput: unknown;
  const controller = new WikiController(
    {} as WikiProfileService,
    {} as WikiReadService,
    {
      async movePage(receivedSession: SessionPayload, pageId: string, body: unknown) {
        mutationInput = { receivedSession, pageId, body };
        return { pageId, namespace: 'guide', spaceId: '22' };
      }
    } as unknown as WikiEditService,
    captchaStub
  );
  const body = {
    namespace: 'guide',
    spaceId: '22',
    title: '새 위치',
    reason: '정리',
    leaveRedirect: true
  };

  await controller.movePage('7', body, session);

  assert.deepEqual(mutationInput, { receivedSession: session, pageId: '7', body });
});

test('public block history controller is callable without an authenticated session', async () => {
  let input: unknown;
  const controller = new WikiController(
    {} as WikiProfileService,
    { async getPublicBlockHistory(value: unknown) { input = value; return { items: [], nextCursor: null }; } } as unknown as WikiReadService,
    {} as WikiEditService,
    captchaStub
  );

  const response = await controller.blockHistory('20', '50', 'block', 'target');
  assert.deepEqual(input, { cursor: '20', limit: '50', action: 'block', query: 'target' });
  assert.deepEqual(response, { items: [], nextCursor: null });
});

test('optional browser wiki reads forward the complete session payload', async () => {
  const session = {
    sessionId: 'session-1',
    userId: 'account-1',
    tokenVersion: 4,
    isElevated: true,
    authenticatedAt: '2026-07-16T00:00:00.000Z',
    groups: ['admin'],
    permissions: ['wiki.read.private'],
    requestIp: '192.0.2.44'
  } satisfies SessionPayload;
  const request = { sessionPayload: session } as FastifyRequest;
  const received: Array<{ readonly method: string; readonly viewer: unknown }> = [];
  const reads = {
    async getPage(_namespace: string, _title: string, viewer: unknown) { received.push({ method: 'page', viewer }); return {}; },
    async getPageByPath(_path: string, viewer: unknown) { received.push({ method: 'by-path', viewer }); return {}; },
    async getRevisions(_pageId: string, viewer: unknown) { received.push({ method: 'revisions', viewer }); return { items: [], nextCursor: null }; },
    async getRenderedRevision(_revisionId: string, viewer: unknown) { received.push({ method: 'rendered-revision', viewer }); return {}; },
    async getBacklinks(input: { viewer?: unknown }) { received.push({ method: 'backlinks', viewer: input.viewer }); return { items: [], nextCursor: null }; },
    async getBlame(_pageId: string, viewer: unknown) { received.push({ method: 'blame', viewer }); return {}; },
    async getRecent(input: { viewer?: unknown }) { received.push({ method: 'recent', viewer: input.viewer }); return { items: [], nextCursor: null }; },
    async search(input: { viewer?: unknown }) { received.push({ method: 'search', viewer: input.viewer }); return { items: [], nextCursor: null }; },
    async suggest(input: { viewer?: unknown }) { received.push({ method: 'suggest', viewer: input.viewer }); return { items: [], exactMatch: null }; },
    async getSpecialDocuments(input: { viewer?: unknown }) { received.push({ method: 'special', viewer: input.viewer }); return { type: 'orphaned', items: [] }; },
    async getCategoryMembers(input: { viewer?: unknown }) { received.push({ method: 'categories', viewer: input.viewer }); return { items: [] }; },
    async getDocumentTemplates(input: { viewer?: unknown }) { received.push({ method: 'templates', viewer: input.viewer }); return []; }
  } as unknown as WikiReadService;
  const edits = {
    async getRawPage(_pageId: string, viewer: unknown) { received.push({ method: 'raw', viewer }); return {}; },
    async getRevision(_revisionId: string, viewer: unknown) { received.push({ method: 'revision', viewer }); return {}; },
    async getRevisionDiff(_leftId: string, _rightId: string, viewer: unknown) { received.push({ method: 'diff', viewer }); return {}; }
  } as unknown as WikiEditService;
  const controller = new WikiController({} as WikiProfileService, reads, edits, captchaStub);

  await Promise.all([
    controller.getPage('main', '대문', request),
    controller.getPageByPath('/wiki/대문', request),
    controller.getRevisions('1', request),
    controller.getPageRaw('1', request),
    controller.getBacklinks('1', request),
    controller.getBlame('1', request),
    controller.getRecent(request),
    controller.search(request, 'query', undefined, undefined, undefined, undefined),
    controller.suggest(request, 'query', undefined),
    controller.special(request),
    controller.categoryMembers('category', request),
    controller.templates(request),
    controller.getRevision('11', request),
    controller.getRenderedRevision('11', request),
    controller.getRevisionDiff('11', '12', request)
  ]);

  assert.deepEqual(received.map((entry) => entry.method).sort(), [
    'backlinks', 'blame', 'by-path', 'categories', 'diff', 'page', 'raw',
    'recent', 'rendered-revision', 'revision', 'revisions', 'search', 'special', 'suggest', 'templates'
  ]);
  assert.equal(received.every((entry) => entry.viewer === session), true);
});

test('anonymous wiki controller read applies CIDR ACL from the central request context', async () => {
  const store = {
    aclRule: {
      async findMany() {
        return [{
          id: 1n, targetType: 'site', targetId: null, action: 'read', effect: 'deny',
          subjectType: 'aclgroup', subjectValue: 'blocked_networks', sortOrder: 1,
          reason: 'blocked_network', expiresAt: null, createdBy: null,
          createdAt: new Date(), updatedAt: new Date()
        }];
      }
    },
    aclGroup: {
      async findUnique() { return { id: 1n, groupKey: 'blocked_networks', status: 'active' }; }
    },
    aclGroupMember: {
      async findFirst() { return null; },
      async findMany() { return [{ cidr: '192.0.2.0/24' }]; }
    },
    wikiNamespace: { async findUnique() { return null; } }
  };
  const acl = new WikiAclService(store as unknown as PrismaService);
  const wikiRead = {
    async getPage() {
      const decision = await acl.evaluate({ actor: null, action: 'read', resource: {} });
      if (decision.matched && !decision.allowed) throw new NotFoundException('Wiki page not found.');
      return {};
    }
  } as unknown as WikiReadService;
  const controller = new WikiController(
    {} as WikiProfileService,
    wikiRead,
    {} as WikiEditService,
    captchaStub
  );
  const guard = new OptionalSessionGuard({
    async getSessionByToken() { return null; }
  } as never);
  const request = {
    method: 'GET', url: '/v1/wiki/page', ip: '192.0.2.50', headers: {}
  } as unknown as FastifyRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => request })
  } as unknown as ExecutionContext;

  await assert.rejects(
    () => new Promise<void>((resolve, reject) => {
      runInHttpRequestContext(request, {} as FastifyReply, () => {
        void guard.canActivate(context)
          .then(() => controller.getPage('main', '대문', request))
          .then(() => resolve(), reject);
      });
    }),
    (error: unknown) => error instanceof NotFoundException
  );
  assert.equal(request.clientIp, '192.0.2.50');
  assert.equal(request.sessionPayload, undefined);
});
