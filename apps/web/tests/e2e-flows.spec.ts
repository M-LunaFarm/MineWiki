import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:3000';
const prisma = hasDatabase ? new PrismaClient() : null;

let serverId = '';
let serverName = '';
let sessionToken = '';

test.describe('End-to-end flows', () => {
  test.skip(!hasDatabase, 'DATABASE_URL is not configured.');

  test.beforeAll(async () => {
    if (!prisma) {
      return;
    }
    await prisma.$connect();
    const accountId = randomUUID();
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
      },
    });
  });

  test.afterAll(async () => {
    if (prisma) {
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
        path: '/',
      },
    ]);
  });

  test('review gating requires login, ownership, and recent vote', async ({ page }) => {
    await page.goto('/servers/' + serverId);

    const composeButton = page.getByRole('button', { name: /리뷰 작성/ });
    await expect(composeButton).toBeEnabled();
    await composeButton.click();

    await page.getByRole('textbox', { name: /내용/ }).fill('테스트 리뷰 내용입니다.');
    await page.getByRole('button', { name: /리뷰 제출/ }).click();
    await expect(page.getByText(/리뷰가 등록되었습니다|리뷰 작성 조건/)).toBeVisible();
  });

  test('claim wizard issues verification token for owned server', async ({ page }) => {
    await page.goto('/claim');

    const serverSelect = page.getByLabel(/대상 서버/);
    await serverSelect.selectOption(serverId);

    await page.getByRole('button', { name: /DNS TXT/ }).click();
    await page.getByRole('button', { name: /검증 토큰 발급|소유권 검증 실행/ }).click();
    await expect(page.getByText(/토큰이 발급되었습니다|검증 토큰/)).toBeVisible();
    await expect(page.getByText(serverName)).toBeVisible();
  });

  test('account center shows minecraft ownership status', async ({ page }) => {
    await page.goto('/me');

    await expect(page.getByRole('heading', { name: /Minecraft 소유권 인증/ })).toBeVisible();
    await expect(page.getByText(/정품 계정을 인증/)).toBeVisible();
  });

  test('landing page shows server discovery entry points', async ({ page }) => {
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: /서버를 검색하고, 검증 상태와 리뷰를 확인하세요/ }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /전체 보기/ })).toBeVisible();
  });
});
