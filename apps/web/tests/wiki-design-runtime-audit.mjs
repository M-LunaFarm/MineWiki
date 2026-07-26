import '../../../scripts/load-environment.mjs';

import { chromium } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { CURRENT_POLICY_VERSIONS } from '@minewiki/schemas';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = process.env.MINEWIKI_AUDIT_BASE_URL ?? 'https://minewiki.kr';
const outputDir = process.env.MINEWIKI_AUDIT_OUTPUT ?? '/tmp/minewiki-wiki-design-runtime-audit';
const ticketId = process.env.MINEWIKI_SUPPORT_TICKET_ID;
if (!ticketId) throw new Error('MINEWIKI_SUPPORT_TICKET_ID is required for the authenticated role.');

const prisma = new PrismaClient();
const sessionId = randomUUID();
const sessionToken = randomBytes(32).toString('base64url');
const routes = [
  { name: 'article', path: '/wiki/%EC%95%84%EB%A5%B4%EB%A7%88%EB%94%9C%EB%A1%9C', heading: '아르마딜로' },
  { name: 'editor', path: '/wiki/_tools/edit/%EC%95%84%EB%A5%B4%EB%A7%88%EB%94%9C%EB%A1%9C', heading: '아르마딜로 편집', mobileOnly: true },
  { name: 'search', path: '/search?q=%EB%8A%91%EB%8C%80', heading: '서버와 지식을 한 번에', mobileOnly: true },
  { name: 'recent', path: '/recent', heading: '최근 변경', mobileOnly: true },
  { name: 'history', path: '/wiki/_tools/history/%EC%95%84%EB%A5%B4%EB%A7%88%EB%94%9C%EB%A1%9C', heading: '아르마딜로', mobileOnly: true },
  { name: 'discussions', path: '/wiki/discussions', heading: '최근 토론', mobileOnly: true },
  { name: 'category', path: '/wiki/category/%EB%8F%99%EB%AC%BC', mobileOnly: true },
  { name: 'special', path: '/wiki/special', heading: '특수 문서', mobileOnly: true },
];
const viewports = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 393, height: 852 },
];

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

let browser;
try {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { requesterAccountId: true },
  });
  if (!ticket?.requesterAccountId) throw new Error('The selected support ticket has no member account.');
  const issuedAt = new Date();
  await prisma.session.create({
    data: {
      id: sessionId,
      accountId: ticket.requesterAccountId,
      token: tokenHash(sessionToken),
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 30 * 60 * 1000),
      tokenVersion: 1,
      primaryAuthenticatedAt: issuedAt,
      ipAddress: '127.0.0.1',
      userAgent: 'MineWiki wiki design runtime audit',
      lastActiveAt: issuedAt,
      termsPolicyVersion: CURRENT_POLICY_VERSIONS.terms.consentVersion,
      privacyPolicyVersion: CURRENT_POLICY_VERSIONS.privacy.consentVersion,
    },
  });

  await mkdir(outputDir, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.CHROME_BINARY_PATH ?? '/usr/bin/google-chrome-stable',
    headless: true,
    args: ['--no-sandbox'],
  });

  const results = [];
  for (const role of ['anonymous', 'member']) {
    for (const theme of ['light', 'dark']) {
      for (const viewport of viewports) {
        for (const route of routes) {
          if (route.mobileOnly && viewport.name !== 'mobile') continue;
          const context = await browser.newContext({
            viewport,
            colorScheme: theme,
            locale: 'ko-KR',
            reducedMotion: 'reduce',
          });
          await context.addInitScript((selectedTheme) => {
            window.localStorage.setItem('minewiki-theme', selectedTheme);
          }, theme);
          if (role === 'member') await context.addCookies([sessionCookie(sessionToken)]);
          const page = await context.newPage();
          const failedResponses = [];
          page.on('response', (response) => {
            if (response.status() >= 500) failedResponses.push({ status: response.status(), url: response.url() });
          });
          let response;
          try {
            response = await page.goto(`${baseUrl}${route.path}`, {
              waitUntil: 'domcontentloaded',
              timeout: 45_000,
            });
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('ERR_ABORTED')) throw error;
            await page.waitForTimeout(300);
            response = await page.goto(`${baseUrl}${route.path}`, {
              waitUntil: 'domcontentloaded',
              timeout: 45_000,
            });
          }
          if (route.heading) {
            await page.getByRole('heading', { name: route.heading, exact: true }).first().waitFor({ timeout: 30_000 });
          } else {
            await page.locator('h1').first().waitFor({ timeout: 30_000 });
          }
          const audit = await page.evaluate(({ pageName, viewportName }) => {
            const visibleDetails = [...document.querySelectorAll('.wiki-reader-rail details')].filter((element) => {
              const style = getComputedStyle(element);
              return style.display !== 'none' && element.getBoundingClientRect().width > 0;
            });
            return {
              pageName,
              viewportName,
              actualTheme: document.documentElement.dataset.theme,
              innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
              overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
              openRailPanels: visibleDetails.filter((element) => element.open).length,
              railTop: Math.round(document.querySelector('.wiki-reader-rail')?.getBoundingClientRect().top ?? 0),
              articleTop: Math.round(document.querySelector('.wiki-rendered')?.getBoundingClientRect().top ?? 0),
            };
          }, { pageName: route.name, viewportName: viewport.name });
          if (audit.actualTheme !== theme) throw new Error(`${role}/${theme}/${viewport.name}/${route.name}: theme mismatch`);
          if (audit.overflow !== 0) throw new Error(`${role}/${theme}/${viewport.name}/${route.name}: overflow ${audit.overflow}px`);
          if (route.name === 'article' && viewport.name === 'desktop' && audit.openRailPanels !== 1) {
            throw new Error(`${role}/${theme}/desktop/article: the TOC must be the only open rail panel`);
          }
          if (route.name === 'article' && viewport.name === 'mobile' && audit.openRailPanels !== 0) {
            throw new Error(`${role}/${theme}/mobile/article: rail panels must start collapsed`);
          }
          if (failedResponses.length > 0) {
            throw new Error(`${role}/${theme}/${viewport.name}/${route.name}: ${JSON.stringify(failedResponses)}`);
          }
          await page.screenshot({
            path: `${outputDir}/${role}-${theme}-${viewport.name}-${route.name}.png`,
            fullPage: true,
            animations: 'disabled',
          });
          results.push({
            role,
            theme,
            viewport: viewport.name,
            route: route.name,
            status: response?.status() ?? null,
            ...audit,
          });
          await context.close();
        }
      }
    }
  }
  await writeFile(`${outputDir}/report.json`, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await prisma.session.deleteMany({ where: { id: sessionId } });
  await prisma.$disconnect();
}
