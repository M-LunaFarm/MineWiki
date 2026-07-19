import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { ServerOwnershipTransferService } from './server-ownership-transfer.service';

const root = new URL('../../../../', import.meta.url);

test('ownership transfer endpoints require dedicated purpose-bound step-up and bounded throttles', async () => {
  const source = await readFile(new URL('apps/api/src/server/server-ownership-transfer.controller.ts', root), 'utf8');
  assert.match(source, /@RequireStepUp\('server_ownership_transfer'\)/u);
  assert.match(source, /@UseGuards\(SessionGuard\)/u);
  assert.match(source, /expectedVersion: z\.number\(\)\.int\(\)\.min\(1\)/u);
  assert.match(source, /@Throttle\(\{ default: \{ limit: 4, ttl: 60 \} \}\)/u);
});

test('ownership acceptance is serialized, billing-fail-closed, and reconciles tenant capabilities', async () => {
  const source = await readFile(new URL('apps/api/src/server/server-ownership-transfer.service.ts', root), 'utf8');
  assert.match(source, /TransactionIsolationLevel\.Serializable/u);
  assert.match(source, /FOR UPDATE/u);
  assert.match(source, /assertNoBillingSubject/u);
  assert.match(source, /providerCustomer|billingSubject/u);
  assert.match(source, /wikiSpace\.update/u);
  assert.match(source, /subwikiRole\.upsert/u);
  assert.match(source, /wikiApiToken\.updateMany/u);
  assert.match(source, /serverClaimMethod\.updateMany/u);
  assert.match(source, /where: \{ serverId: server\.id, accountId: transfer\.sourceOwnerAccountId \}/u);
  assert.match(source, /verifiedAt: null/u);
  assert.match(source, /serverWikiCollaboratorInvitation\.updateMany/u);
});

test('ownership transfer migration enforces one active request and terminal status bounds', async () => {
  const migration = await readFile(new URL('prisma/migrations/20260720020000_server_ownership_transfers/migration.sql', root), 'utf8');
  assert.match(migration, /UNIQUE INDEX `uq_server_ownership_transfer_active` \(`active_server_key`\)/u);
  assert.match(migration, /CHECK \(`status` IN \('pending', 'accepted', 'declined', 'cancelled', 'expired', 'superseded'\)\)/u);
  assert.match(migration, /CHECK \(`source_owner_account_id` <> `target_account_id`\)/u);
});

test('ownership transfer email is fenced by current transfer, profile, account, and email state', async () => {
  const transfer = {
    status: 'pending', version: 1, expiresAt: new Date(Date.now() + 60_000),
    targetAccountId: 'account-target', targetProfileId: 8n,
  };
  const account = {
    id: 'account-target', email: 'target@example.com', emailVerified: true,
    lifecycleStatus: 'active', canonicalAccountId: 'account-target',
  };
  const prisma = {
    serverOwnershipTransfer: { async findUnique() { return transfer; } },
    wikiProfile: { async findUnique() { return { accountId: 'account-target', status: 'active', mergedIntoProfileId: null }; } },
    account: { async findUnique() { return account; } },
  };
  const service = new ServerOwnershipTransferService(prisma as never, {} as never, {} as never, {} as never);
  const fence = service as unknown as { canDeliverRequestEmail(input: {
    transferId: string; transferVersion: number; targetAccountId: string;
    targetProfileId: bigint; email: string;
  }): Promise<boolean> };
  const delivery = {
    transferId: 'transfer-1', transferVersion: 1, targetAccountId: 'account-target',
    targetProfileId: 8n, email: 'target@example.com',
  };

  assert.equal(await fence.canDeliverRequestEmail(delivery), true);
  transfer.status = 'cancelled';
  assert.equal(await fence.canDeliverRequestEmail(delivery), false);
  transfer.status = 'pending';
  account.email = 'changed@example.com';
  assert.equal(await fence.canDeliverRequestEmail(delivery), false);
});
