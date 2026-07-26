import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const baseUrl = process.env.MINEWIKI_RUNTIME_AUDIT_URL ?? 'https://minewiki.kr';
const chromePath = process.env.CHROME_PATH ?? '/usr/bin/google-chrome-stable';
const outputDir =
  process.env.MINEWIKI_RUNTIME_AUDIT_OUTPUT ?? '/tmp/minewiki-wiki-search-sidebar-audit';
const cases = [
  {
    name: 'title-search-desktop-light',
    path: '/search?q=%EB%8C%80%EB%AC%B8',
    viewport: { width: 1440, height: 1000 },
    theme: 'light',
    verify: async (page) => {
      await page.getByRole('heading', { name: '위키 지식' }).waitFor();
      await page.getByRole('link', { name: /대문/ }).first().waitFor();
      if (await page.getByText('제목과 일치하는 문서가 없어 본문 내용에서 찾았습니다.').count()) {
        throw new Error('Title search unexpectedly used the content fallback.');
      }
    },
  },
  {
    name: 'content-fallback-desktop-light',
    path: '/search?q=%EB%8A%91%EB%8C%80%EB%A5%BC%20%EB%8D%B0%EB%A6%AC%EA%B3%A0',
    viewport: { width: 1440, height: 1000 },
    theme: 'light',
    verify: async (page) => {
      await page
        .getByText('제목과 일치하는 문서가 없어 본문 내용에서 찾았습니다.')
        .waitFor();
      await page.getByRole('link', { name: /아르마딜로/ }).waitFor();
    },
  },
  {
    name: 'article-sidebar-desktop-light',
    path: '/wiki/%EC%95%84%EB%A5%B4%EB%A7%88%EB%94%9C%EB%A1%9C',
    viewport: { width: 1440, height: 1000 },
    theme: 'light',
    verify: verifyDesktopSidebar,
  },
  {
    name: 'article-sidebar-desktop-dark',
    path: '/wiki/%EC%95%84%EB%A5%B4%EB%A7%88%EB%94%9C%EB%A1%9C',
    viewport: { width: 1440, height: 1000 },
    theme: 'dark',
    verify: verifyDesktopSidebar,
  },
  {
    name: 'article-sidebar-mobile-light',
    path: '/wiki/%EC%95%84%EB%A5%B4%EB%A7%88%EB%94%9C%EB%A1%9C',
    viewport: { width: 390, height: 844 },
    theme: 'light',
    verify: verifyMobileSidebar,
  },
  {
    name: 'article-sidebar-mobile-dark',
    path: '/wiki/%EC%95%84%EB%A5%B4%EB%A7%88%EB%94%9C%EB%A1%9C',
    viewport: { width: 390, height: 844 },
    theme: 'dark',
    verify: verifyMobileSidebar,
  },
];

async function verifyDesktopSidebar(page) {
  const article = page.locator('article').first();
  const sidebar = page.getByRole('heading', { name: '최근 변경' }).locator('..');
  await sidebar.waitFor();
  const [articleBox, sidebarBox] = await Promise.all([
    article.boundingBox(),
    sidebar.boundingBox(),
  ]);
  if (!articleBox || !sidebarBox || sidebarBox.x <= articleBox.x + articleBox.width) {
    throw new Error('Recent changes is not positioned to the right of the article.');
  }
}

async function verifyMobileSidebar(page) {
  const article = page.locator('article').first();
  const sidebar = page.getByRole('heading', { name: '최근 변경' }).locator('..');
  await sidebar.waitFor();
  const [articleBox, sidebarBox] = await Promise.all([
    article.boundingBox(),
    sidebar.boundingBox(),
  ]);
  if (!articleBox || !sidebarBox || sidebarBox.y <= articleBox.y) {
    throw new Error('Recent changes does not follow the article on mobile.');
  }
}

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: chromePath,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const results = [];
try {
  for (const testCase of cases) {
    const context = await browser.newContext({
      viewport: testCase.viewport,
      colorScheme: testCase.theme,
      locale: 'ko-KR',
      reducedMotion: 'reduce',
    });
    await context.addInitScript((theme) => {
      window.localStorage.setItem('minewiki-theme', theme);
    }, testCase.theme);
    const page = await context.newPage();
    const failedResponses = [];
    page.on('response', (response) => {
      if (response.status() >= 500) {
        failedResponses.push({ status: response.status(), url: response.url() });
      }
    });
    const response = await page.goto(new URL(testCase.path, baseUrl).href, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    if (!response?.ok()) {
      throw new Error(`${testCase.name} navigation failed with ${response?.status() ?? 'no response'}.`);
    }
    await testCase.verify(page);
    const metrics = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      overflow: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    }));
    if (metrics.theme !== testCase.theme || metrics.overflow !== 0 || failedResponses.length > 0) {
      throw new Error(`${testCase.name} failed: ${JSON.stringify({ metrics, failedResponses })}`);
    }
    const screenshotPath = `${outputDir}/${testCase.name}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
    results.push({ ...testCase, screenshotPath, metrics, failedResponses });
    process.stdout.write(`${testCase.name}: passed\n`);
    await context.close();
  }
  const reportPath = `${outputDir}/report.json`;
  await writeFile(reportPath, `${JSON.stringify({ baseUrl, generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
  process.stdout.write(`Report: ${reportPath}\n`);
} finally {
  await browser.close();
}
