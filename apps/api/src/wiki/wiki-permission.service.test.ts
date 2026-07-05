import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaService } from '../common/prisma.service';
import { WikiPermissionService, type WikiPermissionActor, type WikiPermissionPage } from './wiki-permission.service';

function createService(options: {
  readonly space?: { id: bigint; status: string; ownerUserId?: bigint | null } | null;
  readonly roles?: string[];
  readonly serverWiki?: { voteServerId: string | null; createdBy: bigint | null } | null;
  readonly server?: { ownerAccountId: string | null } | null;
  readonly modWiki?: { verifiedBy: bigint | null } | null;
} = {}) {
  const store = {
    wikiProfile: {
      async findUnique() {
        return null;
      }
    },
    wikiSpace: {
      async findUnique() {
        return options.space === undefined ? { id: 10n, status: 'active', ownerUserId: null } : options.space;
      }
    },
    subwikiRole: {
      async findMany() {
        return (options.roles ?? []).map((role) => ({ role }));
      }
    },
    serverWiki: {
      async findFirst() {
        return options.serverWiki ?? null;
      }
    },
    server: {
      async findUnique() {
        return options.server ?? null;
      }
    },
    modWiki: {
      async findFirst() {
        return options.modWiki ?? null;
      }
    }
  };
  return new WikiPermissionService(store as unknown as PrismaService);
}

function page(overrides: Partial<WikiPermissionPage> = {}): WikiPermissionPage {
  return {
    id: 1n,
    spaceId: 10n,
    title: '대문',
    protectionLevel: 'open',
    status: 'normal',
    createdBy: 100n,
    ...overrides
  };
}

function actor(overrides: Partial<WikiPermissionActor> = {}): WikiPermissionActor {
  return {
    accountId: 'account-1',
    profileId: 100n,
    status: 'active',
    ...overrides
  };
}

test('anonymous public read is allowed', async () => {
  const service = createService();
  const decision = await service.canReadPage({
    accountId: null,
    page: page(),
    revision: { visibility: 'public' }
  });

  assert.equal(decision.allowed, true);
});

test('hidden and deleted pages are denied for read', async () => {
  const service = createService();

  const hidden = await service.canReadPage({
    accountId: null,
    page: page({ status: 'hidden' }),
    revision: { visibility: 'public' }
  });
  const deleted = await service.canReadPage({
    accountId: null,
    page: page({ status: 'deleted' }),
    revision: { visibility: 'public' }
  });

  assert.equal(hidden.allowed, false);
  assert.equal(deleted.allowed, false);
});

test('logged-in active user can edit open page', async () => {
  const service = createService();
  const decision = await service.canEditPage({
    actor: actor({ profileId: 200n }),
    page: page({ createdBy: 100n })
  });

  assert.equal(decision.allowed, true);
});

test('normal user cannot edit locked page', async () => {
  const service = createService();
  const decision = await service.canEditPage({
    actor: actor({ profileId: 200n }),
    page: page({ protectionLevel: 'locked', createdBy: 100n })
  });

  assert.equal(decision.allowed, false);
});

test('linked server owner can edit owner-only server wiki page', async () => {
  const service = createService({
    serverWiki: { voteServerId: 'server-1', createdBy: 300n },
    server: { ownerAccountId: 'account-1' }
  });
  const decision = await service.canEditPage({
    actor: actor({ profileId: 200n }),
    page: page({ protectionLevel: 'owner_only', createdBy: 300n })
  });

  assert.equal(decision.allowed, true);
});

test('blocked wiki profile cannot edit open page', async () => {
  const service = createService();
  const decision = await service.canEditPage({
    actor: actor({ status: 'blocked' }),
    page: page()
  });

  assert.equal(decision.allowed, false);
});
