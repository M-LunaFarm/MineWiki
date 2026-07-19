import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Algorithm, hash } from '@node-rs/argon2';
import { PrismaService } from '../common/prisma.service';
import { AccountDeletionService } from './account-deletion.service';
import type { SessionPayload } from '../session/session.service';
import { SessionService } from '../session/session.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const service = new AccountDeletionService(prisma);
  let createdUserNamespaceId: number | null = null;
  let createdUserSpaceId: bigint | null = null;
  before(async () => {
    await prisma.$connect();
    const namespace = await prisma.wikiNamespace.findUnique({ where: { code: 'user' } });
    if (!namespace) {
      const created = await prisma.wikiNamespace.create({ data: { code: 'user', displayName: '사용자', pathPrefix: 'user', isContent: true } });
      createdUserNamespaceId = created.id;
    }
    const space = await prisma.wikiSpace.findUnique({ where: { code: 'user' } });
    if (!space) {
      const created = await prisma.wikiSpace.create({ data: {
        code: 'user', name: '사용자', title: '사용자', rootNamespaceCode: 'user', rootPath: 'user',
        status: 'active', createdAt: new Date(), updatedAt: new Date(),
      } });
      createdUserSpaceId = created.id;
    }
  });
  after(async () => {
    if (createdUserSpaceId) await prisma.wikiSpace.delete({ where: { id: createdUserSpaceId } });
    if (createdUserNamespaceId) await prisma.wikiNamespace.delete({ where: { id: createdUserNamespaceId } });
    await prisma.$disconnect();
  });

  async function createGroup() {
    const firstId = randomUUID();
    const secondId = randomUUID();
    const passwordHash = await hash('CurrentPW1!', { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32, algorithm: Algorithm.Argon2id });
    await prisma.account.createMany({ data: [
      { id: firstId, canonicalAccountId: firstId, provider: 'email', providerUserId: `delete-${firstId}@example.com`, email: `delete-${firstId}@example.com`, emailVerified: true, passwordHash },
      { id: secondId, canonicalAccountId: firstId, provider: 'discord', providerUserId: `delete-${secondId}`, emailVerified: true },
    ] });
    await prisma.accountLink.createMany({ data: [
      { primaryAccountId: firstId, linkedAccountId: secondId },
      { primaryAccountId: secondId, linkedAccountId: firstId },
    ] });
    return { firstId, secondId, session: { sessionId: randomUUID(), userId: firstId, isElevated: false, authenticatedAt: new Date().toISOString() } satisfies SessionPayload };
  }

  async function cleanup(accountIds: string[], serverId?: string) {
    const deletionRequests = await prisma.accountDeletionRequest.findMany({ where: { canonicalAccountId: accountIds[0] }, select: { id: true } });
    if (deletionRequests.length) await prisma.accountDeletionDiscordRevocation.deleteMany({ where: { deletionRequestId: { in: deletionRequests.map((row) => row.id) } } });
    await prisma.auditEvent.deleteMany({ where: { OR: [{ actorAccountId: { in: accountIds } }, { subjectType: 'account_deletion_request', metadata: { path: ['canonicalAccountId'], equals: accountIds[0] } }] } }).catch(() => undefined);
    await prisma.accountDeletionRequest.deleteMany({ where: { canonicalAccountId: accountIds[0] } });
    if (serverId) await prisma.server.delete({ where: { id: serverId } }).catch(() => undefined);
    await prisma.accountLink.deleteMany({ where: { OR: [{ primaryAccountId: { in: accountIds } }, { linkedAccountId: { in: accountIds } }] } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }

  test('owned assets block termination before credentials or canonical account state change', async () => {
    const group = await createGroup();
    const server = await prisma.server.create({ data: {
      ownerAccountId: group.secondId, name: `Owned ${randomUUID()}`, joinHost: 'owned.example.com', joinPort: 25565,
      edition: 'java', supportedVersions: ['1.21'], tags: ['test'], shortDescription: 'owned', longDescription: 'owned server',
    } });
    await prisma.session.create({ data: { id: group.session.sessionId, accountId: group.firstId, token: randomUUID(), issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), tokenVersion: 1, lastActiveAt: new Date() } });
    try {
      await assert.rejects(() => service.requestDeletion({ session: group.session, password: 'CurrentPW1!' }), (error: unknown) => {
        const response = (error as { getResponse?: () => unknown }).getResponse?.() as { code?: string; blockers?: Array<{ type: string; id: string }> };
        return response?.code === 'ACCOUNT_DELETION_ASSET_TRANSFER_REQUIRED' && response.blockers?.some((item) => item.type === 'server' && item.id === server.id) === true;
      });
      assert.equal(await prisma.session.count({ where: { accountId: group.firstId } }), 1);
      assert.equal(await prisma.account.count({ where: { id: { in: [group.firstId, group.secondId] }, lifecycleStatus: 'active' } }), 2);
    } finally { await cleanup([group.firstId, group.secondId], server.id); }
  });

  test('request revokes the entire canonical group and concurrent cancellation succeeds only once', async () => {
    const group = await createGroup();
    await prisma.session.createMany({ data: [
      { id: group.session.sessionId, accountId: group.firstId, token: randomUUID(), issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), tokenVersion: 1, lastActiveAt: new Date() },
      { id: randomUUID(), accountId: group.secondId, token: randomUUID(), issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), tokenVersion: 1, lastActiveAt: new Date() },
    ] });
    await prisma.oAuthCredential.create({ data: { accountId: group.secondId, provider: 'discord', providerUserId: `delete-${group.secondId}`, accessToken: 'secret' } });
    await prisma.passwordReset.create({ data: { token: randomUUID(), accountId: group.firstId, email: `delete-${group.firstId}@example.com`, expiresAt: new Date(Date.now() + 60_000) } });
    await prisma.wikiApiToken.create({ data: {
      accountId: group.secondId,
      name: 'account deletion test',
      tokenPrefix: randomUUID().replaceAll('-', '').slice(0, 12),
      secretHash: createHash('sha256').update(randomUUID()).digest('hex'),
      scopes: ['wiki:read'],
      expiresAt: new Date(Date.now() + 60_000),
    } });
    try {
      const requested = await service.requestDeletion({ session: group.session, password: 'CurrentPW1!' });
      assert.equal(await prisma.account.count({ where: { id: { in: [group.firstId, group.secondId] }, lifecycleStatus: 'deletion_pending' } }), 2);
      assert.equal(await prisma.session.count({ where: { accountId: { in: [group.firstId, group.secondId] } } }), 0);
      assert.equal(await prisma.oAuthCredential.count({ where: { accountId: group.secondId } }), 0);
      assert.equal(await prisma.passwordReset.count({ where: { accountId: group.firstId } }), 0);
      assert.equal(await prisma.wikiApiToken.count({ where: { accountId: { in: [group.firstId, group.secondId] } } }), 0);
      await assert.rejects(() => new SessionService(prisma).issueSession({ userId: group.secondId }), /활성 상태가 아닙니다/);

      const results = await Promise.allSettled([service.cancel(requested.cancelToken), service.cancel(requested.cancelToken)]);
      assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
      assert.equal(await prisma.account.count({ where: { id: { in: [group.firstId, group.secondId] }, lifecycleStatus: 'active' } }), 2);
    } finally { await cleanup([group.firstId, group.secondId]); }
  });

  test('a password account always requires its current password even with a fresh elevated session', async () => {
    const group = await createGroup();
    try {
      await assert.rejects(() => service.requestDeletion({
        session: { ...group.session, isElevated: true, authenticatedAt: new Date().toISOString() }
      }), /현재 비밀번호/);
      assert.equal(await prisma.account.count({ where: { id: { in: [group.firstId, group.secondId] }, lifecycleStatus: 'active' } }), 2);
    } finally { await cleanup([group.firstId, group.secondId]); }
  });

  test('cancellation email keeps the one-time token in a URL fragment', async () => {
    const group = await createGroup();
    let deliveredUrl = '';
    const email = {
      async sendAccountDeletionCancellationEmail(payload: { cancelUrl: string }) { deliveredUrl = payload.cancelUrl; },
      logDeliveryFailure() {},
    };
    const configuredService = new AccountDeletionService(
      prisma,
      undefined,
      email as never,
      { getOptional: () => 'https://minewiki.kr' } as never,
    );
    try {
      const requested = await configuredService.requestDeletion({ session: group.session, password: 'CurrentPW1!' });
      assert.ok(deliveredUrl.startsWith('https://minewiki.kr/account-deletion/cancel#token='));
      assert.equal(new URL(deliveredUrl).search, '');
      assert.equal(new URL(deliveredUrl).hash.slice('#token='.length), requested.cancelToken);
      await configuredService.cancel(requested.cancelToken);
    } finally { await cleanup([group.firstId, group.secondId]); }
  });

  test('creator and registrant authority are explicit account termination blockers', async () => {
    const group = await createGroup();
    const now = new Date();
    const profile = await prisma.wikiProfile.create({ data: {
      accountId: group.firstId, username: `delete-${randomUUID()}`, displayName: '종료 테스트', status: 'active', createdAt: now, updatedAt: now,
    } });
    const space = await prisma.wikiSpace.create({ data: {
      code: `delete-${randomUUID()}`, name: '종료 테스트 공간', title: '종료 테스트 공간', rootNamespaceCode: 'wiki', rootPath: `delete-${randomUUID()}`, status: 'active', createdBy: profile.id, createdAt: now, updatedAt: now,
    } });
    const serverWiki = await prisma.serverWiki.create({ data: {
      spaceId: space.id, serverName: '종료 테스트 서버 위키', slug: `delete-${randomUUID()}`, status: 'active', createdBy: profile.id, createdAt: now, updatedAt: now,
    } });
    const modWiki = await prisma.modWiki.create({ data: {
      spaceId: space.id, modName: '종료 테스트 모드', slug: `delete-${randomUUID()}`, status: 'active', verifiedBy: profile.id, createdAt: now, updatedAt: now,
    } });
    const server = await prisma.server.create({ data: {
      registrantAccountId: group.secondId, name: `Registered ${randomUUID()}`, joinHost: 'registered.example.com', joinPort: 25565,
      edition: 'java', supportedVersions: ['1.21'], tags: ['test'], shortDescription: 'registered', longDescription: 'registered server',
    } });
    const claim = await prisma.serverClaimMethod.create({ data: {
      serverId: server.id, accountId: group.firstId, method: 'dns', token: randomUUID(), issuedAt: now, status: 'pending',
    } });
    try {
      await assert.rejects(() => service.requestDeletion({ session: group.session, password: 'CurrentPW1!' }), (error: unknown) => {
        const response = (error as { getResponse?: () => unknown }).getResponse?.() as { blockers?: Array<{ type: string }> };
        const types = new Set(response?.blockers?.map((item) => item.type));
        return ['wiki_space', 'server_wiki', 'mod_wiki', 'server_registration', 'server_claim'].every((type) => types.has(type));
      });
    } finally {
      await prisma.serverClaimMethod.delete({ where: { id: claim.id } }).catch(() => undefined);
      await prisma.server.delete({ where: { id: server.id } }).catch(() => undefined);
      await prisma.modWiki.delete({ where: { id: modWiki.id } }).catch(() => undefined);
      await prisma.serverWiki.delete({ where: { id: serverWiki.id } }).catch(() => undefined);
      await prisma.wikiSpace.delete({ where: { id: space.id } }).catch(() => undefined);
      await prisma.wikiProfile.delete({ where: { id: profile.id } }).catch(() => undefined);
      await cleanup([group.firstId, group.secondId]);
    }
  });

  test('transferred wiki provenance does not block the former owner from terminating the account', async () => {
    const group = await createGroup();
    const targetAccountId = randomUUID();
    const now = new Date();
    await prisma.account.create({ data: {
      id: targetAccountId,
      canonicalAccountId: targetAccountId,
      provider: 'email',
      providerUserId: `transfer-target-${targetAccountId}@example.com`,
      email: `transfer-target-${targetAccountId}@example.com`,
      emailVerified: true,
    } });
    const sourceProfile = await prisma.wikiProfile.create({ data: {
      accountId: group.firstId, username: `source_${randomUUID().slice(0, 20)}`,
      displayName: '이전 소유자', status: 'active', createdAt: now, updatedAt: now,
    } });
    const targetProfile = await prisma.wikiProfile.create({ data: {
      accountId: targetAccountId, username: `target_${randomUUID().slice(0, 20)}`,
      displayName: '현재 소유자', status: 'active', createdAt: now, updatedAt: now,
    } });
    const space = await prisma.wikiSpace.create({ data: {
      code: `transferred-${randomUUID()}`, name: '이전된 공간', title: '이전된 공간',
      rootNamespaceCode: 'server', rootPath: `transferred-${randomUUID()}`,
      status: 'active', createdBy: sourceProfile.id, ownerUserId: targetProfile.id,
      createdAt: now, updatedAt: now,
    } });
    const serverWiki = await prisma.serverWiki.create({ data: {
      spaceId: space.id, serverName: '이전된 서버 위키', slug: `transferred-${randomUUID()}`,
      status: 'active', createdBy: sourceProfile.id, createdAt: now, updatedAt: now,
    } });
    try {
      const requested = await service.requestDeletion({ session: group.session, password: 'CurrentPW1!' });
      assert.equal(requested.status, 'requested');
      await service.cancel(requested.cancelToken);
    } finally {
      await prisma.serverWiki.delete({ where: { id: serverWiki.id } }).catch(() => undefined);
      await prisma.wikiSpace.delete({ where: { id: space.id } }).catch(() => undefined);
      await prisma.wikiProfile.delete({ where: { id: sourceProfile.id } }).catch(() => undefined);
      await prisma.wikiProfile.delete({ where: { id: targetProfile.id } }).catch(() => undefined);
      await cleanup([group.firstId, group.secondId]);
      await prisma.account.delete({ where: { id: targetAccountId } }).catch(() => undefined);
    }
  });

  test('an OAuth-only account can request deletion only within 15 minutes of a new login', async () => {
    const group = await createGroup();
    await prisma.account.update({ where: { id: group.firstId }, data: { passwordHash: null } });
    try {
      await assert.rejects(() => service.requestDeletion({
        session: { ...group.session, authenticatedAt: new Date(Date.now() - 16 * 60_000).toISOString() },
      }), /다시 로그인한 뒤 15분/);
      const requested = await service.requestDeletion({ session: group.session });
      assert.equal(requested.status, 'requested');
      await service.cancel(requested.cancelToken);
    } finally { await cleanup([group.firstId, group.secondId]); }
  });

  test('due processing tombstones user documents without losing immutable ownership', async () => {
    const group = await createGroup();
    const now = new Date();
    const profile = await prisma.wikiProfile.create({
      data: {
        accountId: group.firstId,
        username: `user_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        displayName: '탈퇴 문서 테스트',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    });
    const [namespace, space] = await Promise.all([
      prisma.wikiNamespace.findUniqueOrThrow({ where: { code: 'user' } }),
      prisma.wikiSpace.findUniqueOrThrow({ where: { code: 'user' } }),
    ]);
    const root = await prisma.wikiPage.create({
      data: {
        namespaceId: namespace.id,
        spaceId: space.id,
        localPath: profile.username,
        slug: profile.username,
        title: profile.username,
        displayTitle: profile.displayName,
        pageType: 'article',
        protectionLevel: 'open',
        status: 'normal',
        createdBy: profile.id,
        ownerProfileId: profile.id,
        createdAt: now,
        updatedAt: now,
      },
    });
    const child = await prisma.wikiPage.create({
      data: {
        namespaceId: namespace.id,
        spaceId: space.id,
        localPath: `${profile.username}/개인_작업실`,
        slug: `${profile.username}/개인_작업실`,
        title: `${profile.username}/개인_작업실`,
        displayTitle: '개인 작업실',
        pageType: 'article',
        protectionLevel: 'open',
        status: 'normal',
        createdBy: profile.id,
        ownerProfileId: profile.id,
        createdAt: now,
        updatedAt: now,
      },
    });
    await prisma.wikiRecentChange.create({
      data: {
        pageId: root.id,
        actorId: profile.id,
        changeType: 'create',
        title: profile.username,
        namespaceCode: 'user',
        isMinor: false,
        createdAt: now,
      },
    });
    const editRequest = await prisma.wikiEditRequest.create({
      data: {
        requestKind: 'create',
        targetNamespaceId: namespace.id,
        targetNamespaceCode: 'user',
        targetSpaceId: space.id,
        targetTitle: `${profile.username}/제안`,
        targetSlug: `${profile.username}/제안`,
        targetDisplayTitle: '제안',
        targetPageType: 'article',
        targetOwnerProfileId: profile.id,
        proposedContent: '사용자 문서 제안',
        editSummary: '탈퇴 전 제안',
        status: 'stale',
        createdBy: profile.id,
        createdAt: now,
        updatedAt: now,
      },
    });

    try {
      const requested = await service.requestDeletion({ session: group.session, password: 'CurrentPW1!' });
      await prisma.accountDeletionRequest.update({
        where: { id: requested.id },
        data: { scheduledFor: new Date(Date.now() - 1000) },
      });
      const completed = await service.process(requested.id, randomUUID(), 'user document privacy test');
      assert.equal(completed.status, 'completed');

      const [storedProfile, storedRoot, storedChild, recent, storedEditRequest, usernameAlias] = await Promise.all([
        prisma.wikiProfile.findUniqueOrThrow({ where: { id: profile.id } }),
        prisma.wikiPage.findUniqueOrThrow({ where: { id: root.id } }),
        prisma.wikiPage.findUniqueOrThrow({ where: { id: child.id } }),
        prisma.wikiRecentChange.findFirstOrThrow({ where: { pageId: root.id } }),
        prisma.wikiEditRequest.findUniqueOrThrow({ where: { id: editRequest.id } }),
        prisma.wikiUsernameAlias.findUnique({ where: { oldUsername: profile.username } }),
      ]);
      assert.equal(storedProfile.username, `deleted-${profile.id}`);
      assert.equal(storedProfile.status, 'closed');
      assert.equal(storedRoot.localPath, `deleted-${profile.id}`);
      assert.equal(storedChild.localPath, `deleted-${profile.id}/page-${child.id}`);
      assert.equal(storedRoot.status, 'deleted');
      assert.equal(storedChild.status, 'deleted');
      assert.equal(storedRoot.ownerProfileId, profile.id);
      assert.equal(storedChild.ownerProfileId, profile.id);
      assert.equal(recent.title, `deleted-${profile.id}`);
      assert.equal(storedEditRequest.status, 'closed');
      assert.equal(storedEditRequest.targetTitle, `deleted-${profile.id}`);
      assert.equal(storedEditRequest.targetSlug, `deleted-${profile.id}`);
      assert.equal(usernameAlias?.profileId, profile.id);
      assert.doesNotMatch(`${storedRoot.title}/${storedChild.title}`, new RegExp(profile.username, 'u'));
    } finally {
      const pageIds = [root.id, child.id];
      await prisma.wikiEditRequest.deleteMany({ where: { id: editRequest.id } });
      await prisma.wikiPageLink.deleteMany({ where: { OR: [{ sourcePageId: { in: pageIds } }] } });
      await prisma.wikiRecentChange.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiPageRenderCache.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiSearchDocument.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiPageRevision.deleteMany({ where: { pageId: { in: pageIds } } });
      await prisma.wikiPage.deleteMany({ where: { id: { in: pageIds } } });
      await prisma.wikiProfile.delete({ where: { id: profile.id } }).catch(() => undefined);
      await cleanup([group.firstId, group.secondId]);
    }
  });

  test('due processing retains wiki report evidence while nulling reporter identity', async () => {
    const group = await createGroup();
    const now = new Date();
    const profile = await prisma.wikiProfile.create({
      data: {
        accountId: group.firstId,
        username: `report_delete_${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        displayName: '신고자 탈퇴 테스트',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    });
    const evidenceSnapshot = {
      capturedAt: now.toISOString(),
      targetType: 'page',
      targetId: profile.id.toString(),
      excerpt: '탈퇴 후에도 보존할 증거',
    };
    const reportCase = await prisma.wikiReportCase.create({
      data: {
        targetType: 'page',
        targetId: profile.id,
        pageId: profile.id,
        activeKey: `page:${profile.id}`,
        reportCount: 1,
        evidenceSnapshot,
        statusUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    const submission = await prisma.wikiReportSubmission.create({
      data: {
        caseId: reportCase.id,
        reporterProfileId: profile.id,
        reason: '계정 삭제 익명화 검증',
        evidenceSnapshot,
        createdAt: now,
      },
    });

    try {
      const requested = await service.requestDeletion({ session: group.session, password: 'CurrentPW1!' });
      await prisma.accountDeletionRequest.update({
        where: { id: requested.id },
        data: { scheduledFor: new Date(Date.now() - 1000) },
      });
      const completed = await service.process(requested.id, randomUUID(), 'wiki report privacy test');
      assert.equal(completed.status, 'completed');

      const [storedSubmission, storedCase] = await Promise.all([
        prisma.wikiReportSubmission.findUniqueOrThrow({ where: { id: submission.id } }),
        prisma.wikiReportCase.findUniqueOrThrow({ where: { id: reportCase.id } }),
      ]);
      assert.equal(storedSubmission.reporterProfileId, null);
      assert.deepEqual(storedSubmission.evidenceSnapshot, evidenceSnapshot);
      assert.deepEqual(storedCase.evidenceSnapshot, evidenceSnapshot);
      assert.equal(storedCase.reportCount, 1);
    } finally {
      await prisma.wikiReportCase.delete({ where: { id: reportCase.id } }).catch(() => undefined);
      await prisma.wikiProfile.delete({ where: { id: profile.id } }).catch(() => undefined);
      await cleanup([group.firstId, group.secondId]);
    }
  });

  test('due processing preserves public review and vote rows while removing account identifiers', async () => {
    const group = await createGroup();
    const minecraftUuid = randomUUID();
    const discordUserId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const guildId = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const verificationSessionId = randomUUID();
    const eventId = randomUUID().replaceAll('-', '');
    await prisma.minecraftIdentity.create({ data: { accountId: group.secondId, uuid: minecraftUuid, playerName: 'Player', msOwned: true, lastVerifiedAt: new Date() } });
    await prisma.lunaGuild.create({ data: { guildId, verifiedRoleId: 'role-1', createdAt: new Date(), updatedAt: new Date() } });
    await prisma.lunaDiscordAccountLink.create({ data: { discordUserId, minecraftUuid, minecraftName: 'Player', lastVerifiedAt: new Date(), updatedAt: new Date() } });
    await prisma.lunaGuildVerification.create({ data: { guildId, discordUserId, minecraftUuid, status: 'verified', verifiedAt: new Date() } });
    await prisma.lunaPrivacyConsent.create({ data: { discordUserId, consentType: 'verify', consentedAt: new Date(), updatedAt: new Date() } });
    await prisma.lunaEvent.create({ data: { eventId, eventType: 'minecraft_verified', guildId, discordUserId, minecraftUuid, minecraftName: 'Player', occurredAt: new Date().toISOString(), createdAt: new Date() } });
    const pluginEvent = await prisma.serverPluginSyncEvent.create({ data: { discordUserId, minecraftUuid, playerName: 'Player', action: 'verified', payload: { accountId: group.firstId } } });
    await prisma.discordVerificationSession.create({ data: {
      id: verificationSessionId, status: 'synced', guildId, channelId: 'channel-1', requesterDiscordId: discordUserId,
      accountId: group.firstId, minecraftUuid, minecraftName: 'Player', roleId: 'role-1', eventLog: { discordUserId },
      expiresAt: new Date(Date.now() + 60_000), completedAt: new Date(),
    } });
    const server = await prisma.server.create({ data: {
      name: `Public ${randomUUID()}`, joinHost: 'public.example.com', joinPort: 25565, edition: 'java',
      supportedVersions: ['1.21'], tags: ['test'], shortDescription: 'public', longDescription: 'public server',
    } });
    const vote = await prisma.vote.create({ data: { serverId: server.id, accountId: group.secondId, minecraftUuid, username: 'Player', usernameNormalized: 'player', ipAddress: '192.0.2.1', votedAt: new Date() } });
    const verifiedEmailKey = createHash('sha256')
      .update(`delete-${group.firstId}@example.com`)
      .digest('hex');
    await prisma.voteCooldownClaim.create({
      data: {
        identityType: 'verified_email',
        identityKey: verifiedEmailKey,
        serverId: server.id,
        kstDay: new Date(new Date().toISOString().slice(0, 10)),
        voteId: vote.id,
      },
    });
    const review = await prisma.serverReview.create({ data: { serverId: server.id, authorAccountId: group.firstId, authorDisplayName: 'Player', rating: 5, body: '보존할 리뷰', tags: [], evidenceMinecraftUuid: minecraftUuid, evidenceVoteId: vote.id, evidenceVerifiedAt: new Date(), evidencePolicyVersion: 'v1' } });
    const outsider = await prisma.account.create({ data: {
      id: randomUUID(), provider: 'email', providerUserId: `review-outsider-${randomUUID()}@example.com`, emailVerified: true,
    } });
    await prisma.reviewHelpfulVote.createMany({ data: [
      { reviewId: review.id, accountId: group.secondId, isHelpful: true, lastMarkedAt: new Date() },
      { reviewId: review.id, accountId: outsider.id, isHelpful: true, lastMarkedAt: new Date() },
    ] });
    await prisma.reviewReport.create({ data: {
      reviewId: review.id,
      accountId: group.secondId,
      reason: '보존해야 하는 신고 사건',
      status: 'resolved',
      resolution: '운영 검토 완료',
      statusUpdatedAt: new Date(),
      resolvedAt: new Date(),
    } });
    await prisma.serverReview.update({ where: { id: review.id }, data: { helpfulCount: 2, reports: 1 } });
    try {
      const requested = await service.requestDeletion({ session: group.session, password: 'CurrentPW1!' });
      await prisma.accountDeletionRequest.update({ where: { id: requested.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
      const completed = await service.process(requested.id, randomUUID(), 'retention test');
      assert.equal(completed.status, 'completed');
      const [storedReview, storedVote] = await Promise.all([
        prisma.serverReview.findUnique({ where: { id: review.id } }), prisma.vote.findUnique({ where: { id: vote.id } }),
      ]);
      assert.equal(storedReview?.body, '보존할 리뷰');
      assert.equal(storedReview?.authorDisplayName, '탈퇴한 사용자');
      assert.equal(storedReview?.isAnonymous, true);
      assert.equal(storedReview?.evidenceMinecraftUuid, null);
      assert.equal(storedReview?.evidenceVoteId, null);
      assert.equal(storedReview?.helpfulCount, 1);
      assert.equal(storedReview?.reports, 1);
      const preservedReport = await prisma.reviewReport.findFirst({ where: { reviewId: review.id } });
      assert.equal(preservedReport?.accountId, group.secondId);
      assert.equal(preservedReport?.status, 'resolved');
      assert.equal(preservedReport?.resolution, '운영 검토 완료');
      assert.equal(storedVote?.accountId, null);
      assert.equal(storedVote?.minecraftUuid, null);
      assert.equal(storedVote?.ipAddress, null);
      assert.equal(await prisma.voteCooldownClaim.count({ where: { identityKey: verifiedEmailKey } }), 0);
      const storedSession = await prisma.discordVerificationSession.findUnique({ where: { id: verificationSessionId } });
      assert.equal(storedSession?.accountId, null);
      assert.equal(storedSession?.minecraftUuid, null);
      assert.equal(storedSession?.status, 'revoke_pending');
      assert.match(storedSession?.requesterDiscordId ?? '', /^deleted:/u);
      assert.equal(await prisma.accountDeletionDiscordRevocation.count({ where: { deletionRequestId: requested.id, discordUserId } }), 2);
      assert.equal(await prisma.lunaDiscordAccountLink.count({ where: { discordUserId } }), 0);
      assert.equal(await prisma.lunaGuildVerification.count({ where: { guildId, discordUserId } }), 0);
      assert.equal(await prisma.lunaPrivacyConsent.count({ where: { discordUserId } }), 0);
      assert.equal((await prisma.serverPluginSyncEvent.findUnique({ where: { id: pluginEvent.id } }))?.minecraftUuid, '00000000-0000-0000-0000-000000000000');
      assert.equal((await prisma.lunaEvent.findUnique({ where: { eventId } }))?.minecraftUuid, '00000000-0000-0000-0000-000000000000');
      assert.equal(await prisma.account.count({ where: { id: { in: [group.firstId, group.secondId] }, lifecycleStatus: 'anonymized', email: null, passwordHash: null } }), 2);
    } finally {
      await prisma.discordVerificationSession.deleteMany({ where: { id: verificationSessionId } });
      await prisma.serverPluginSyncEvent.deleteMany({ where: { id: pluginEvent.id } });
      await prisma.lunaEvent.deleteMany({ where: { eventId } });
      await prisma.lunaPrivacyConsent.deleteMany({ where: { discordUserId } });
      await prisma.lunaGuildVerification.deleteMany({ where: { guildId, discordUserId } });
      await prisma.lunaDiscordAccountLink.deleteMany({ where: { discordUserId } });
      await prisma.lunaGuild.deleteMany({ where: { guildId } });
      await cleanup([group.firstId, group.secondId], server.id);
      await prisma.account.delete({ where: { id: outsider.id } }).catch(() => undefined);
    }
  });

  test('concurrent due processors claim once and emit one completion audit event', async () => {
    const group = await createGroup();
    try {
      const requested = await service.requestDeletion({ session: group.session, password: 'CurrentPW1!' });
      await prisma.accountDeletionRequest.update({ where: { id: requested.id }, data: { scheduledFor: new Date(Date.now() - 1000) } });
      const results = await Promise.allSettled([
        service.process(requested.id, randomUUID(), 'first processor'),
        service.process(requested.id, randomUUID(), 'second processor'),
      ]);
      assert.equal(results.filter((item) => item.status === 'rejected').length, 0);
      assert.equal((await prisma.accountDeletionRequest.findUnique({ where: { id: requested.id } }))?.status, 'completed');
      assert.equal(await prisma.auditEvent.count({ where: { subjectType: 'account_deletion_request', subjectId: requested.id, action: 'account.deletion.completed' } }), 1);
      assert.equal(await prisma.account.count({ where: { id: { in: [group.firstId, group.secondId] }, lifecycleStatus: 'anonymized' } }), 2);
    } finally { await cleanup([group.firstId, group.secondId]); }
  });

  test('completion atomically revokes all active non-owner wiki roles and audits the exact count', async () => {
    const group = await createGroup();
    const unique = randomUUID().replaceAll('-', '');
    const now = new Date();
    const ownerAccountId = randomUUID();
    const processorId = randomUUID();
    const triggerName = `account_deletion_audit_fail_${unique.slice(0, 20)}`;
    let triggerCreated = false;
    await prisma.account.create({ data: {
      id: ownerAccountId,
      canonicalAccountId: ownerAccountId,
      provider: 'email',
      providerUserId: `role-owner-${unique}@example.com`,
      email: `role-owner-${unique}@example.com`,
      emailVerified: true,
    } });
    const ownerProfile = await prisma.wikiProfile.create({ data: {
      accountId: ownerAccountId,
      username: `role_owner_${unique.slice(0, 20)}`,
      displayName: '역할 공간 소유자',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    } });
    const deletingProfile = await prisma.wikiProfile.create({ data: {
      accountId: group.firstId,
      username: `role_delete_${unique.slice(0, 20)}`,
      displayName: '역할 삭제 대상',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    } });
    const space = await prisma.wikiSpace.create({ data: {
      code: `role-delete-${unique}`,
      name: '역할 해제 테스트 공간',
      title: '역할 해제 테스트 공간',
      rootNamespaceCode: 'wiki',
      rootPath: `role-delete-${unique}`,
      ownerUserId: ownerProfile.id,
      status: 'active',
      createdBy: ownerProfile.id,
      createdAt: now,
      updatedAt: now,
    } });
    const roles = ['editor', 'reviewer', 'trusted', 'legacy-custom'];
    await prisma.subwikiRole.createMany({ data: roles.map((role) => ({
      spaceId: space.id,
      userId: deletingProfile.id,
      role,
      status: 'active',
      grantedBy: ownerProfile.id,
      grantedAt: now,
    })) });

    try {
      const requested = await service.requestDeletion({ session: group.session, password: 'CurrentPW1!' });
      await prisma.accountDeletionRequest.update({
        where: { id: requested.id },
        data: { scheduledFor: new Date(Date.now() - 1000) },
      });
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER \`${triggerName}\`
        BEFORE INSERT ON audit_events
        FOR EACH ROW
        BEGIN
          IF NEW.action = 'account.deletion.completed' AND NEW.subject_id = '${requested.id}' THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced account deletion audit failure';
          END IF;
        END
      `);
      triggerCreated = true;

      await assert.rejects(
        () => service.process(requested.id, processorId, 'forced rollback test'),
        /forced account deletion audit failure/u,
      );
      assert.equal(await prisma.subwikiRole.count({
        where: { userId: deletingProfile.id, status: 'active', role: { in: roles } },
      }), roles.length);
      assert.equal((await prisma.wikiProfile.findUniqueOrThrow({ where: { id: deletingProfile.id } })).status, 'active');
      assert.equal(await prisma.account.count({
        where: { id: { in: [group.firstId, group.secondId] }, lifecycleStatus: 'deletion_pending' },
      }), 2);

      await prisma.$executeRawUnsafe(`DROP TRIGGER \`${triggerName}\``);
      triggerCreated = false;
      const completed = await service.process(requested.id, processorId, 'collaborator cleanup test');
      assert.equal(completed.status, 'completed');

      const storedRoles = await prisma.subwikiRole.findMany({
        where: { userId: deletingProfile.id, role: { in: roles } },
        orderBy: { role: 'asc' },
      });
      assert.equal(storedRoles.length, roles.length);
      assert.ok(storedRoles.every((role) => role.status === 'revoked'));
      assert.ok(storedRoles.every((role) => role.revokedAt instanceof Date));
      assert.ok(storedRoles.every((role) => role.revokedBy === null));
      const audit = await prisma.auditEvent.findFirstOrThrow({
        where: {
          subjectType: 'account_deletion_request',
          subjectId: requested.id,
          action: 'account.deletion.completed',
        },
      });
      assert.equal((audit.metadata as { wikiCollaboratorRolesRevoked?: number }).wikiCollaboratorRolesRevoked, roles.length);
    } finally {
      if (triggerCreated) await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS \`${triggerName}\``);
      await prisma.subwikiRole.deleteMany({ where: { spaceId: space.id } });
      await prisma.wikiSpace.delete({ where: { id: space.id } }).catch(() => undefined);
      await prisma.wikiProfile.deleteMany({ where: { id: { in: [deletingProfile.id, ownerProfile.id] } } });
      await prisma.account.delete({ where: { id: ownerAccountId } }).catch(() => undefined);
      await cleanup([group.firstId, group.secondId]);
    }
  });

  test('automatic processing includes only stale processing claims in its recovery query', async () => {
    let receivedWhere: unknown;
    const recoveryService = new AccountDeletionService({
      accountDeletionRequest: {
        async findMany(input: { where: unknown }) { receivedWhere = input.where; return [{ id: 'stale-processing' }]; },
      },
    } as never);
    Object.assign(recoveryService, {
      async process(requestId: string) {
        assert.equal(requestId, 'stale-processing');
        return { status: 'completed' };
      },
    });
    assert.deepEqual(await recoveryService.processDue('internal:worker', 1), { processed: 1, blocked: 0, failed: 0 });
    const serialized = JSON.stringify(receivedWhere);
    assert.match(serialized, /"status":"processing"/u);
    assert.match(serialized, /"updatedAt":\{"lte":"/u);
  });
}
