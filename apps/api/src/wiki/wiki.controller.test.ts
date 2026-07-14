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
    {} as WikiEditService
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
