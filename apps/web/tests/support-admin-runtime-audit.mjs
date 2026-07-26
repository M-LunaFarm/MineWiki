/* global document, getComputedStyle, innerHeight, innerWidth, window */

import '../../../scripts/load-environment.mjs';

import { chromium } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { CURRENT_POLICY_VERSIONS } from '@minewiki/schemas';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = process.env.MINEWIKI_AUDIT_BASE_URL ?? 'https://minewiki.kr';
const outputDir =
  process.env.MINEWIKI_AUDIT_OUTPUT ?? '/tmp/minewiki-support-admin-audit';
const prisma = new PrismaClient();
const fixture = {
  adminId: randomUUID(),
  customerId: randomUUID(),
  serverId: randomUUID(),
  ticketId: randomUUID(),
  messageId: randomUUID(),
  sessionId: randomUUID(),
  sessionToken: randomBytes(32).toString('base64url'),
};

function tokenHash(token) {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

function sessionCookie(token) {
  const target = new URL(baseUrl);
  return {
    name: 'mw_session',
    value: token,
    domain: target.hostname,
    path: '/',
    httpOnly: true,
    secure: target.protocol === 'https:',
    sameSite: 'Lax',
  };
}

async function createFixture() {
  const ownerRole = await prisma.globalRole.findUnique({ where: { code: 'owner' } });
  if (!ownerRole) throw new Error('Missing seeded owner role.');
  const now = new Date();
  for (const [id, label] of [
    [fixture.adminId, 'Support Runtime Admin'],
    [fixture.customerId, 'Support Runtime Customer'],
  ]) {
    await prisma.account.create({
      data: {
        id,
        provider: 'email',
        providerUserId: `support-runtime-${id}@example.com`,
        email: `support-runtime-${id}@example.com`,
        emailVerified: true,
        displayName: label,
      },
    });
    await prisma.accountConsent.createMany({
      data: ['terms', 'privacy'].map((consentType) => ({
        accountId: id,
        consentType,
        policyVersion:
          CURRENT_POLICY_VERSIONS[consentType].consentVersion,
        ipAddress: '127.0.0.1',
        userAgent: 'MineWiki support admin runtime audit',
      })),
    });
  }
  await prisma.accountRole.create({
    data: { accountId: fixture.adminId, roleId: ownerRole.id },
  });
  await prisma.session.create({
    data: {
      id: fixture.sessionId,
      accountId: fixture.adminId,
      token: tokenHash(fixture.sessionToken),
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      tokenVersion: 1,
      primaryAuthenticatedAt: now,
      ipAddress: '127.0.0.1',
      userAgent: 'MineWiki support admin runtime audit',
      lastActiveAt: now,
      termsPolicyVersion: CURRENT_POLICY_VERSIONS.terms.consentVersion,
      privacyPolicyVersion: CURRENT_POLICY_VERSIONS.privacy.consentVersion,
    },
  });
  await prisma.server.create({
    data: {
      id: fixture.serverId,
      ownerAccountId: fixture.customerId,
      registrantAccountId: fixture.customerId,
      name: 'Runtime Pending Server',
      joinHost: 'pending.runtime.example',
      joinPort: 25565,
      edition: 'java',
      listingStatus: 'pending',
      supportedVersions: ['26.2'],
      tags: ['runtime-audit'],
      shortDescription: '고객센터 운영 화면 검증용 임시 서버입니다.',
      longDescription: '감사 완료 후 자동 삭제됩니다.',
    },
  });
  await prisma.supportTicket.create({
    data: {
      id: fixture.ticketId,
      requesterAccountId: fixture.customerId,
      serverId: fixture.serverId,
      serverNameSnapshot: 'Runtime Pending Server',
      serverJoinHostSnapshot: 'pending.runtime.example',
      serverJoinPortSnapshot: 25565,
      serverEditionSnapshot: 'java',
      subject: 'Runtime support context audit',
      status: 'open',
      priority: 'high',
      category: 'server_registration',
      lastMessageAt: now,
      messages: {
        create: {
          id: fixture.messageId,
          authorAccountId: fixture.customerId,
          authorRole: 'customer',
          body: '서버 검증 상태를 확인해 주세요.',
        },
      },
    },
  });
}

async function removeFixture() {
  await prisma.supportTicket.deleteMany({ where: { id: fixture.ticketId } });
  await prisma.server.deleteMany({ where: { id: fixture.serverId } });
  await prisma.account.deleteMany({
    where: { id: { in: [fixture.adminId, fixture.customerId] } },
  });
}

function inspectLayout(page, theme) {
  return page.evaluate((expectedTheme) => {
    const surface = document.querySelector('.support-surface');
    const background = surface ? getComputedStyle(surface).backgroundColor : '';
    const rgb = background.match(/\d+/gu)?.slice(0, 3).map(Number) ?? [];
    const lightBackground =
      rgb.length === 3 && rgb.every((channel) => Number.isFinite(channel)) &&
      rgb.reduce((sum, channel) => sum + channel, 0) / 3 > 190;
    return {
      theme: document.documentElement.dataset.theme,
      horizontalOverflow:
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      surfaceBackground: background,
      lightBackground,
      viewport: { width: innerWidth, height: innerHeight },
    };
  }, theme);
}

let browser;
try {
  await createFixture();
  await mkdir(outputDir, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BINARY_PATH ?? '/usr/bin/google-chrome-stable',
    headless: true,
    args: ['--no-sandbox'],
  });
  const results = [];
  for (const theme of ['light', 'dark']) {
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 1000 },
      { name: 'mobile', width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        locale: 'ko-KR',
        reducedMotion: 'reduce',
      });
      await context.addInitScript((value) => {
        window.localStorage.setItem('minewiki-theme', value);
      }, theme);
      await context.addCookies([sessionCookie(fixture.sessionToken)]);
      const page = await context.newPage();
      const failedResponses = [];
      page.on('response', (response) => {
        if (response.status() >= 500) {
          failedResponses.push({ status: response.status(), url: response.url() });
        }
      });
      await page.goto(`${baseUrl}/admin/support`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await page
        .getByRole('heading', { name: '문의 인박스를 분류하고 배정하여 처리 상태를 관리하세요.' })
        .waitFor({ timeout: 30_000 });
      await page.getByText('Runtime support context audit', { exact: true }).first().click();
      await page.getByText('Runtime Pending Server', { exact: true }).last().waitFor();
      await page.getByText('검증 대기', { exact: true }).last().waitFor();
      const inspection = await inspectLayout(page, theme);
      if (inspection.theme !== theme) throw new Error(`Theme mismatch: ${JSON.stringify(inspection)}`);
      if (inspection.horizontalOverflow > 1) {
        throw new Error(`Horizontal overflow: ${JSON.stringify(inspection)}`);
      }
      if (theme === 'light' && !inspection.lightBackground) {
        throw new Error(`Light surface remained dark: ${JSON.stringify(inspection)}`);
      }
      if (failedResponses.length > 0) {
        throw new Error(`Server errors: ${JSON.stringify(failedResponses)}`);
      }
      const screenshot = `${outputDir}/${viewport.name}-${theme}.png`;
      await page.screenshot({ path: screenshot, fullPage: true });
      results.push({ theme, viewport: viewport.name, inspection, screenshot });
      await context.close();
    }
  }
  for (const theme of ['light', 'dark']) {
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 1000 },
      { name: 'mobile', width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        locale: 'ko-KR',
        reducedMotion: 'reduce',
      });
      await context.addInitScript((value) => {
        window.localStorage.setItem('minewiki-theme', value);
      }, theme);
      const page = await context.newPage();
      await page.goto(`${baseUrl}/support`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await page
        .getByRole('heading', {
          name: '서비스 이용 중 발생한 문제를 정확하게 접수하고 처리 현황을 확인하세요.',
        })
        .waitFor({ timeout: 30_000 });
      const inspection = await inspectLayout(page, theme);
      if (inspection.theme !== theme || inspection.horizontalOverflow > 1) {
        throw new Error(`Customer support layout mismatch: ${JSON.stringify(inspection)}`);
      }
      if (theme === 'light' && !inspection.lightBackground) {
        throw new Error(`Customer light surface remained dark: ${JSON.stringify(inspection)}`);
      }
      const screenshot = `${outputDir}/customer-${viewport.name}-${theme}.png`;
      await page.screenshot({ path: screenshot, fullPage: true });
      results.push({
        role: 'anonymous-customer',
        theme,
        viewport: viewport.name,
        inspection,
        screenshot,
      });
      await context.close();
    }
  }
  await writeFile(
    `${outputDir}/result.json`,
    `${JSON.stringify({ ok: true, results }, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify({ ok: true, outputDir, results }, null, 2));
} finally {
  await browser?.close();
  await removeFixture().catch(() => undefined);
  await prisma.$disconnect();
}
