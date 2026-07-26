/* global CSS, document, getComputedStyle, innerHeight, innerWidth, location, window */

import '../../../scripts/load-environment.mjs';

import { chromium } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { CURRENT_POLICY_VERSIONS } from '@minewiki/schemas';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';

const baseUrl = process.env.MINEWIKI_AUDIT_BASE_URL ?? 'https://minewiki.kr';
const outputDir =
  process.env.MINEWIKI_AUDIT_OUTPUT ?? '/tmp/minewiki-server-onboarding-audit';
const chromePath =
  process.env.CHROME_BINARY_PATH ?? '/usr/bin/google-chrome-stable';
const prisma = new PrismaClient();

const viewports = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
};
const themes = ['light', 'dark'];
const selectedRoles = new Set(
  (process.env.MINEWIKI_AUDIT_ROLES ?? 'anonymous,user,admin')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const selectedViewports = new Set(
  (process.env.MINEWIKI_AUDIT_VIEWPORTS ?? 'desktop,mobile')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const fixtures = {
  user: null,
  admin: null,
  serverId: null,
};

function sessionTokenHash(token) {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

async function createAccountFixture(label, roleCode) {
  const accountId = randomUUID();
  const email = `runtime-audit-${label}-${randomUUID()}@example.com`;
  const sessionToken = randomBytes(32).toString('base64url');
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 2 * 60 * 60 * 1000);

  await prisma.account.create({
    data: {
      id: accountId,
      provider: 'email',
      providerUserId: email,
      email,
      displayName: label === 'admin' ? 'Runtime Audit Admin' : 'Runtime Audit User',
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
        userAgent: 'MineWiki server onboarding runtime audit',
      },
      {
        accountId,
        consentType: 'privacy',
        policyVersion: CURRENT_POLICY_VERSIONS.privacy.consentVersion,
        ipAddress: '127.0.0.1',
        userAgent: 'MineWiki server onboarding runtime audit',
      },
    ],
  });
  if (roleCode) {
    const role = await prisma.globalRole.findUnique({ where: { code: roleCode } });
    if (!role) throw new Error(`Missing seeded global role: ${roleCode}`);
    await prisma.accountRole.create({
      data: { accountId, roleId: role.id },
    });
  }
  await prisma.session.create({
    data: {
      id: randomUUID(),
      accountId,
      token: sessionTokenHash(sessionToken),
      issuedAt,
      expiresAt,
      tokenVersion: 1,
      isElevated: false,
      primaryAuthenticatedAt: issuedAt,
      ipAddress: '127.0.0.1',
      userAgent: 'MineWiki server onboarding runtime audit',
      lastActiveAt: issuedAt,
      termsPolicyVersion: CURRENT_POLICY_VERSIONS.terms.consentVersion,
      privacyPolicyVersion: CURRENT_POLICY_VERSIONS.privacy.consentVersion,
    },
  });
  return { accountId, email, sessionToken };
}

async function createFixtures() {
  fixtures.user = await createAccountFixture('user', null);
  fixtures.admin = await createAccountFixture('admin', 'owner');
  const server = await prisma.server.create({
    data: {
      ownerAccountId: fixtures.user.accountId,
      registrantAccountId: fixtures.user.accountId,
      name: `Runtime Audit Server ${randomUUID().slice(0, 6)}`,
      joinHost: 'play.example.com',
      joinPort: 25565,
      edition: 'java',
      listingStatus: 'pending',
      supportedVersions: ['1.21.1'],
      tags: ['runtime-audit'],
      shortDescription: '서버 등록과 소유권 검증 화면을 점검하는 임시 서버입니다.',
      longDescription: '감사가 끝나면 계정과 함께 자동으로 삭제됩니다.',
      verificationGrade: 'Unverified',
      voteCooldownHours: 24,
      stats: {
        create: {
          rankCurrent: 1,
          rankDelta24h: 0,
          rankBest: 1,
          votesLast24h: 0,
          votesLast7d: 0,
          votesMonthToDate: 0,
          votesTotal: 0,
          playersOnline: 0,
          playersMax: 0,
          uptimePercent: 0,
          sparkline: [],
          latencyMs: 0,
        },
      },
    },
  });
  fixtures.serverId = server.id;
}

async function removeFixtures() {
  const accountIds = [fixtures.user?.accountId, fixtures.admin?.accountId].filter(Boolean);
  if (fixtures.serverId) {
    await prisma.server.deleteMany({ where: { id: fixtures.serverId } });
  }
  if (accountIds.length > 0) {
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
}

function cookieFor(sessionToken) {
  const target = new URL(baseUrl);
  return {
    name: 'mw_session',
    value: sessionToken,
    domain: target.hostname,
    path: '/',
    httpOnly: true,
    secure: target.protocol === 'https:',
    sameSite: 'Lax',
  };
}

async function inspectPage(page, expectedTheme) {
  return page.evaluate((theme) => {
    const parseColor = (value) => {
      const match = value.match(/rgba?\(([^)]+)\)/u);
      if (!match) return null;
      const parts = match[1].split(/[\s,/]+/u).filter(Boolean).map(Number);
      if (parts.length < 3 || parts.some(Number.isNaN)) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
    };
    const luminance = ({ r, g, b }) => {
      const channels = [r, g, b].map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const selector = (element) => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const classes = [...element.classList]
        .filter((name) => !name.includes(':') && !name.includes('['))
        .slice(0, 3);
      return `${element.tagName.toLowerCase()}${classes.map((name) => `.${CSS.escape(name)}`).join('')}`;
    };
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const viewportArea = innerWidth * innerHeight;
    const darkSurfaceMismatches = [];
    if (theme === 'light') {
      for (const element of document.querySelectorAll('body *')) {
        if (!visible(element) || element.closest('.dark-fixed-surface')) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width * rect.height < viewportArea * 0.06) continue;
        const style = getComputedStyle(element);
        const background = parseColor(style.backgroundColor);
        if (
          background &&
          background.a >= 0.85 &&
          luminance(background) < 0.12 &&
          style.backgroundImage === 'none'
        ) {
          darkSurfaceMismatches.push({
            selector: selector(element),
            background: style.backgroundColor,
            area: Math.round(rect.width * rect.height),
          });
        }
      }
    }

    return {
      title: document.title,
      finalUrl: location.href,
      actualTheme: document.documentElement.dataset.theme,
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      darkSurfaceMismatches: darkSurfaceMismatches.slice(0, 20),
    };
  }, expectedTheme);
}

async function prepareRegistrationForm(page) {
  await page.locator('#server-name').fill('런타임 감사 서버');
  await page.locator('#server-join-host').fill('play.example.com');
  await page.getByRole('button', { name: '1.21.1' }).click();
  await page.locator('#server-short-description').fill('가입 전 서버 정보를 한눈에 확인합니다.');
  await page
    .locator('#server-long-description')
    .fill('서버 특징, 운영 규칙, 검증 이후 공개 절차를 안내하는 상세 설명입니다.');
  await page.getByLabel('태그').fill('야생, 커뮤니티');
  await page.getByLabel('웹사이트').fill('https://example.com');
}

async function captureMatrix(browser) {
  const results = [];
  const roles = [
    { name: 'anonymous', fixture: null },
    { name: 'user', fixture: fixtures.user },
    { name: 'admin', fixture: fixtures.admin },
  ];

  for (const role of roles.filter((candidate) => selectedRoles.has(candidate.name))) {
    for (const [viewportName, viewport] of Object.entries(viewports)) {
      if (!selectedViewports.has(viewportName)) {
        continue;
      }
      for (const theme of themes) {
        const context = await browser.newContext({
          viewport,
          colorScheme: theme,
          locale: 'ko-KR',
          reducedMotion: 'reduce',
        });
        await context.addInitScript((selectedTheme) => {
          window.localStorage.setItem('minewiki-theme', selectedTheme);
        }, theme);
        if (role.fixture) {
          await context.addCookies([cookieFor(role.fixture.sessionToken)]);
        }

        for (const surface of ['register', 'claim']) {
          const page = await context.newPage();
          const consoleErrors = [];
          const failedResponses = [];
          page.on('console', (message) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
          });
          page.on('pageerror', (error) => consoleErrors.push(error.message));
          page.on('response', (candidate) => {
            if (candidate.status() >= 500) {
              failedResponses.push({ status: candidate.status(), url: candidate.url() });
            }
          });
          const requestedPath =
            surface === 'register'
              ? '/servers/register'
              : `/claim?serverId=${fixtures.serverId}`;
          const response = await page.goto(new URL(requestedPath, baseUrl).href, {
            waitUntil: 'domcontentloaded',
            timeout: 45_000,
          });
          await page.waitForTimeout(1_200);

          let interaction = 'none';
          if (role.fixture && surface === 'register') {
            await prepareRegistrationForm(page);
            interaction = 'completed-form';
          }
          if (
            role.name === 'user' &&
            surface === 'claim' &&
            viewportName === 'desktop' &&
            theme === 'light'
          ) {
            await page.getByRole('button', { name: /DNS TXT/ }).click();
            const responsePromise = page.waitForResponse(
              (candidate) =>
                candidate.url().includes(`/v1/servers/${fixtures.serverId}/claim/start`) &&
                candidate.request().method() === 'POST',
              { timeout: 20_000 },
            );
            await page
              .getByRole('button', { name: /검증 토큰 발급|소유권 검증 실행/ })
              .click();
            const claimResponse = await responsePromise;
            if (!claimResponse.ok()) {
              throw new Error(
                `Claim token issuance failed: ${claimResponse.status()} ${await claimResponse.text()}`,
              );
            }
            await page.getByText(/DNS TXT 토큰을 발급했습니다/).waitFor();
            interaction = 'issued-dns-token';
          }
          await page.waitForTimeout(400);
          const audit = await inspectPage(page, theme);
          const screenshotPath = `${outputDir}/${role.name}-${viewportName}-${theme}-${surface}.png`;
          await page.screenshot({
            path: screenshotPath,
            fullPage: true,
            animations: 'disabled',
            timeout: 45_000,
          });

          const authenticated = role.fixture !== null;
          const remainedOnRequestedSurface =
            surface === 'register'
              ? new URL(audit.finalUrl).pathname === '/servers/register'
              : new URL(audit.finalUrl).pathname === '/claim';
          if (authenticated !== remainedOnRequestedSurface) {
            throw new Error(
              `${role.name}/${surface}: unexpected auth routing to ${audit.finalUrl}`,
            );
          }
          if (audit.horizontalOverflow !== 0) {
            throw new Error(
              `${role.name}/${viewportName}/${theme}/${surface}: ${audit.horizontalOverflow}px horizontal overflow`,
            );
          }
          if (audit.actualTheme !== theme) {
            throw new Error(
              `${role.name}/${viewportName}/${surface}: expected ${theme}, got ${audit.actualTheme}`,
            );
          }
          if (audit.darkSurfaceMismatches.length > 0) {
            throw new Error(
              `${role.name}/${viewportName}/${surface}: dark light-theme surfaces ${JSON.stringify(audit.darkSurfaceMismatches)}`,
            );
          }
          if (failedResponses.length > 0) {
            throw new Error(
              `${role.name}/${viewportName}/${theme}/${surface}: server errors ${JSON.stringify(failedResponses)}`,
            );
          }

          results.push({
            role: role.name,
            viewport: viewportName,
            theme,
            surface,
            requestedPath,
            status: response?.status() ?? null,
            interaction,
            screenshotPath,
            consoleErrors: [...new Set(consoleErrors)],
            failedResponses,
            ...audit,
          });
          process.stdout.write(
            `${role.name}/${viewportName}/${theme}/${surface}: ${audit.finalUrl} (${interaction})\n`,
          );
          await page.close();
        }
        await context.close();
      }
    }
  }
  return results;
}

await mkdir(outputDir, { recursive: true });
await prisma.$connect();
let browser;
let results = [];
try {
  await createFixtures();
  browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  results = await captureMatrix(browser);
  const reportPath = `${outputDir}/report.json`;
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        baseUrl,
        generatedAt: new Date().toISOString(),
        matrix: {
          roles: ['anonymous', 'user', 'admin'].filter((role) => selectedRoles.has(role)),
          viewports: Object.keys(viewports).filter((viewport) =>
            selectedViewports.has(viewport),
          ),
          themes,
          surfaces: ['register', 'claim'],
        },
        results,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(`Report: ${reportPath}\n`);
} finally {
  await browser?.close();
  await removeFixtures();
  await prisma.$disconnect();
}
