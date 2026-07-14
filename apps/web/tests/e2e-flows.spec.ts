import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { CURRENT_POLICY_VERSIONS } from '@minewiki/schemas';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:3000';
const prisma = hasDatabase ? new PrismaClient() : null;

let serverId = '';
let serverName = '';
let sessionToken = '';
let accountId = '';

test.describe('End-to-end flows', () => {
  test.skip(!hasDatabase, 'DATABASE_URL is not configured.');

  test.beforeAll(async () => {
    if (!prisma) {
      return;
    }
    await prisma.$connect();
    accountId = randomUUID();
    const email = 'e2e-' + randomUUID() + '@example.com';

    await prisma.account.create({
      data: {
        id: accountId,
        provider: 'email',
        providerUserId: email,
        email,
        displayName: 'E2E User',
        emailVerified: true,
      },
    });
    await prisma.accountConsent.createMany({
      data: [
        {
          accountId,
          consentType: 'terms',
          policyVersion: CURRENT_POLICY_VERSIONS.terms.consentVersion,
          ipAddress: '127.0.0.1',
          userAgent: 'Playwright',
        },
        {
          accountId,
          consentType: 'privacy',
          policyVersion: CURRENT_POLICY_VERSIONS.privacy.consentVersion,
          ipAddress: '127.0.0.1',
          userAgent: 'Playwright',
        },
      ],
    });

    serverName = 'E2E Server ' + randomUUID().slice(0, 6);
    const server = await prisma.server.create({
      data: {
        ownerAccountId: accountId,
        name: serverName,
        joinHost: 'play.example.com',
        joinPort: 25565,
        edition: 'java',
        supportedVersions: ['1.20.1'],
        tags: ['community'],
        shortDescription: 'E2E test server',
        longDescription: 'E2E test server long description',
        websiteUrl: null,
        discordUrl: null,
      },
    });
    serverId = server.id;

    const minecraftUuid = randomUUID();
    await prisma.minecraftIdentity.create({
      data: {
        accountId,
        uuid: minecraftUuid,
        msOwned: true,
        lastVerifiedAt: new Date(),
      },
    });

    await prisma.vote.create({
      data: {
        serverId,
        accountId,
        minecraftUuid,
        username: 'E2EPlayer',
        usernameNormalized: 'e2eplayer',
        ipAddress: '127.0.0.1',
        votedAt: new Date(),
      },
    });

    sessionToken = randomBytes(32).toString('base64url');
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 14 * 24 * 60 * 60 * 1000);
    await prisma.session.create({
      data: {
        id: randomUUID(),
        accountId,
        token: `sha256:${createHash('sha256').update(sessionToken).digest('hex')}`,
        issuedAt,
        expiresAt,
        tokenVersion: 1,
        isElevated: false,
        ipAddress: '127.0.0.1',
        userAgent: 'Playwright',
        lastActiveAt: issuedAt,
        termsPolicyVersion: CURRENT_POLICY_VERSIONS.terms.consentVersion,
        privacyPolicyVersion: CURRENT_POLICY_VERSIONS.privacy.consentVersion,
      },
    });
  });

  test.afterAll(async () => {
    if (prisma) {
      if (serverId) {
        await prisma.server.deleteMany({ where: { id: serverId } });
      }
      if (accountId) {
        await prisma.wikiProfile.deleteMany({ where: { accountId } });
        await prisma.account.deleteMany({ where: { id: accountId } });
      }
      await prisma.$disconnect();
    }
  });

  test.beforeEach(async ({ context }) => {
    if (!sessionToken) {
      return;
    }
    await context.addCookies([
      {
        name: 'mw_session',
        value: sessionToken,
        url: baseUrl,
      },
    ]);
  });

  test('review gating requires login, ownership, and recent vote', async ({ page }) => {
    const gateResponsePromise = page.waitForResponse(
      (response) => response.url().includes(`/v1/servers/${serverId}/reviews/gate`),
    );
    await page.goto('/servers/' + serverId);
    const gateResponse = await gateResponsePromise;
    const gate = (await gateResponse.json()) as {
      isLoggedIn: boolean;
      isMinecraftOwned: boolean;
      hasRecentVote: boolean;
    };
    expect(gate).toMatchObject({
      isLoggedIn: true,
      isMinecraftOwned: true,
      hasRecentVote: true,
    });

    const composeButton = page.getByRole('button', { name: /리뷰 작성/ });
    await expect(composeButton).toBeEnabled();
    await composeButton.click();

    await page.getByRole('textbox', { name: /내용/ }).fill('테스트 리뷰 내용입니다.');
    await page.getByRole('button', { name: /리뷰 제출/ }).click();
    await expect(page.getByText('테스트 리뷰 내용입니다.', { exact: true })).toBeVisible();
  });

  test('claim wizard issues verification token for owned server', async ({ page }) => {
    await page.goto('/claim');

    const serverSelect = page.getByLabel(/대상 서버/);
    await serverSelect.selectOption(serverId);

    await page.getByRole('button', { name: /DNS TXT/ }).click();
    const startResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/v1/servers/${serverId}/claim/start`) &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: /검증 토큰 발급|소유권 검증 실행/ }).click();
    const startResponse = await startResponsePromise;
    expect(startResponse.ok(), await startResponse.text()).toBeTruthy();
    await expect(page.getByText(/DNS TXT 토큰을 발급했습니다/)).toBeVisible();
    await expect(serverSelect).toHaveValue(serverId);
  });

  test('account center shows minecraft ownership status', async ({ page }) => {
    await page.goto('/me');

    await expect(page.getByRole('heading', { name: /Minecraft 소유권 인증/ })).toBeVisible();
    await expect(page.getByText(/정품 계정을 인증/)).toBeVisible();
  });

  test('landing page is the searchable server directory', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('searchbox').first()).toBeVisible();
    await expect(page.getByRole('combobox', { name: '서버 정렬' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '서버 정렬' })).toContainText('동접순');
  });
});
