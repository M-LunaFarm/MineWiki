import '../../../scripts/load-environment.mjs';

import { chromium } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { CURRENT_POLICY_VERSIONS } from '@minewiki/schemas';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const ticketId = process.env.MINEWIKI_SUPPORT_TICKET_ID;
if (!ticketId) {
  throw new Error('MINEWIKI_SUPPORT_TICKET_ID is required.');
}

const baseUrl = process.env.MINEWIKI_AUDIT_BASE_URL ?? 'https://minewiki.kr';
const outputDir =
  process.env.MINEWIKI_AUDIT_OUTPUT ?? '/tmp/minewiki-support-ticket-runtime-audit';
const prisma = new PrismaClient();
const sessionId = randomUUID();
const sessionToken = randomBytes(32).toString('base64url');

function sessionTokenHash(token) {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

function cookieFor(token) {
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

async function auditPage(page, expectedTheme) {
  return page.evaluate((theme) => {
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
    const parseRgb = (value) => {
      const match = value.match(/rgba?\(([^)]+)\)/u);
      if (!match) return null;
      const parts = match[1].split(/[\s,/]+/u).filter(Boolean).map(Number);
      return parts.length >= 3 ? parts.slice(0, 3) : null;
    };
    const luminance = (rgb) => {
      const channels = rgb.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrastRatio = (foreground, background) => {
      const lighter = Math.max(luminance(foreground), luminance(background));
      const darker = Math.min(luminance(foreground), luminance(background));
      return (lighter + 0.05) / (darker + 0.05);
    };
    const backgroundFor = (element) => {
      let current = element;
      while (current) {
        const backgroundValue = getComputedStyle(current).backgroundColor;
        const color = parseRgb(backgroundValue);
        const alphaMatch = backgroundValue.match(/rgba\([^)]*[,/]\s*([\d.]+)\s*\)/u);
        const alpha = alphaMatch ? Number(alphaMatch[1]) : 1;
        if (color && alpha >= 0.5) {
          return color;
        }
        current = current.parentElement;
      }
      return theme === 'light' ? [255, 255, 255] : [17, 18, 20];
    };
    const lowContrast = [];
    for (const element of document.querySelectorAll('h1,h2,h3,p,span,button,label')) {
      if (!visible(element) || !element.textContent?.trim()) continue;
      if (element.children.length > 0 && !element.matches('button,label')) continue;
      const foreground = parseRgb(getComputedStyle(element).color);
      if (!foreground) continue;
      const ratio = contrastRatio(foreground, backgroundFor(element));
      if (ratio < 3) {
        lowContrast.push({
          tag: element.tagName,
          text: element.textContent.trim().slice(0, 60),
          ratio: Number(ratio.toFixed(2)),
        });
      }
    }
    return {
      actualTheme: document.documentElement.dataset.theme,
      innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      lowContrast: lowContrast.slice(0, 20),
    };
  }, expectedTheme);
}

let browser;
try {
  const ticket = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { requesterAccountId: true, subject: true },
  });
  if (!ticket?.requesterAccountId) {
    throw new Error(`Ticket ${ticketId} has no member requester.`);
  }
  const issuedAt = new Date();
  await prisma.session.create({
    data: {
      id: sessionId,
      accountId: ticket.requesterAccountId,
      token: sessionTokenHash(sessionToken),
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 30 * 60 * 1000),
      tokenVersion: 1,
      primaryAuthenticatedAt: issuedAt,
      ipAddress: '127.0.0.1',
      userAgent: 'MineWiki support ticket runtime audit',
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
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 393, height: 852 },
      colorScheme: theme,
      locale: 'ko-KR',
      reducedMotion: 'reduce',
    });
    await context.addInitScript((selectedTheme) => {
      window.localStorage.setItem('minewiki-theme', selectedTheme);
    }, theme);
    await context.addCookies([cookieFor(sessionToken)]);
    const page = await context.newPage();
    const failedResponses = [];
    page.on('response', (response) => {
      if (response.status() >= 500) {
        failedResponses.push({ status: response.status(), url: response.url() });
      }
    });
    const response = await page.goto(`${baseUrl}/support?ticket=${ticketId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.getByRole('heading', { name: ticket.subject }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: '문의 목록' }).waitFor();
    const before = await auditPage(page, theme);
    await page.screenshot({
      path: `${outputDir}/owner-mobile-${theme}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    await page.evaluate(() => {
      const backButton = [...document.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('문의 목록'),
      );
      if (!(backButton instanceof HTMLButtonElement)) {
        throw new Error('Mobile ticket list button disappeared before interaction.');
      }
      backButton.click();
    });
    await page.locator('aside button').filter({ hasText: ticket.subject }).waitFor();
    const afterBack = await auditPage(page, theme);

    if (before.actualTheme !== theme || afterBack.actualTheme !== theme) {
      throw new Error(`${theme}: theme did not apply.`);
    }
    if (before.overflow !== 0 || afterBack.overflow !== 0) {
      throw new Error(
        `${theme}: horizontal overflow detail=${before.overflow}, list=${afterBack.overflow}`,
      );
    }
    if (before.lowContrast.length > 0) {
      throw new Error(`${theme}: low contrast ${JSON.stringify(before.lowContrast)}`);
    }
    if (failedResponses.length > 0) {
      throw new Error(`${theme}: server errors ${JSON.stringify(failedResponses)}`);
    }
    results.push({
      theme,
      status: response?.status() ?? null,
      detail: before,
      list: afterBack,
      failedResponses,
    });
    await context.close();
  }
  await writeFile(`${outputDir}/report.json`, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser?.close();
  await prisma.session.deleteMany({ where: { id: sessionId } });
  await prisma.$disconnect();
}
