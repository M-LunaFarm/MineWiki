import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';

const baseUrl = process.env.MINEWIKI_AUDIT_BASE_URL ?? 'https://minewiki.kr';
const outputDir = process.env.MINEWIKI_AUDIT_OUTPUT ?? '/tmp/minewiki-theme-audit/local';
const routes = (process.env.MINEWIKI_AUDIT_ROUTES ?? [
  '/',
  '/servers',
  '/servers/4cfjfkz',
  '/wiki/%EB%8C%80%EB%AC%B8',
  '/recent',
  '/search',
  '/wiki/discussions',
  '/login',
  '/login/forgot-password',
  '/policies',
  '/support',
  '/servers/register',
  '/me',
].join(','))
  .split(',')
  .map((route) => route.trim())
  .filter(Boolean);

const viewports = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1440, height: 900 },
};

const slugify = (route) => route === '/'
  ? 'home'
  : decodeURIComponent(route)
      .replace(/^\/+|\/+$/gu, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'root';

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_BINARY_PATH || '/usr/bin/google-chrome-stable',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const results = [];

try {
  for (const [viewportName, viewport] of Object.entries(viewports)) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport,
        colorScheme: theme,
        reducedMotion: 'reduce',
        locale: 'ko-KR',
      });
      await context.addInitScript((selectedTheme) => {
        window.localStorage.setItem('minewiki-theme', selectedTheme);
      }, theme);

      for (const route of routes) {
        const page = await context.newPage();
        const consoleErrors = [];
        page.on('console', (message) => {
          if (message.type() === 'error') consoleErrors.push(message.text());
        });
        page.on('pageerror', (error) => consoleErrors.push(error.message));

        let response = null;
        let navigationError = null;
        try {
          response = await page.goto(new URL(route, baseUrl).href, {
            waitUntil: 'domcontentloaded',
            timeout: 45_000,
          });
        } catch (error) {
          navigationError = error instanceof Error ? error.message : String(error);
        }
        await page.waitForTimeout(1_200);
        await page.evaluate((selectedTheme) => {
          document.documentElement.dataset.theme = selectedTheme;
          document.documentElement.style.colorScheme = selectedTheme;
        }, theme);
        await page.evaluate(() => document.fonts?.ready);

        const screenshot = `${outputDir}/${String(results.length + 1).padStart(2, '0')}-${slugify(route)}-${viewportName}-${theme}.png`;
        let screenshotError = null;
        try {
          await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled', timeout: 45_000 });
        } catch (error) {
          screenshotError = error instanceof Error ? error.message : String(error);
          await page.screenshot({ path: screenshot, fullPage: false, animations: 'disabled', timeout: 15_000 });
        }

        const audit = await page.evaluate(({ expectedTheme }) => {
          const parseColor = (value) => {
            const match = value.match(/rgba?\(([^)]+)\)/u);
            if (!match) return null;
            const parts = match[1].split(/[\s,/]+/u).filter(Boolean).map(Number);
            if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
            return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
          };
          const blend = (front, back) => {
            const alpha = front.a + back.a * (1 - front.a);
            if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
            return {
              r: (front.r * front.a + back.r * back.a * (1 - front.a)) / alpha,
              g: (front.g * front.a + back.g * back.a * (1 - front.a)) / alpha,
              b: (front.b * front.a + back.b * back.a * (1 - front.a)) / alpha,
              a: alpha,
            };
          };
          const luminance = ({ r, g, b }) => {
            const values = [r, g, b].map((channel) => {
              const value = channel / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
            return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
          };
          const contrast = (foreground, background) => {
            const a = luminance(foreground);
            const b = luminance(background);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          };
          const selector = (element) => {
            if (element.id) return `#${CSS.escape(element.id)}`;
            const parts = [];
            let current = element;
            while (current && current !== document.body && parts.length < 4) {
              let part = current.tagName.toLowerCase();
              const stableClasses = [...current.classList].filter((name) => !name.includes(':') && !name.includes('[')).slice(0, 2);
              if (stableClasses.length) part += `.${stableClasses.map((name) => CSS.escape(name)).join('.')}`;
              const siblings = current.parentElement ? [...current.parentElement.children].filter((item) => item.tagName === current.tagName) : [];
              if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
              parts.unshift(part);
              current = current.parentElement;
            }
            return parts.join(' > ');
          };
          const effectiveBackground = (element) => {
            const chain = [];
            for (let current = element; current; current = current.parentElement) chain.unshift(current);
            let color = expectedTheme === 'light'
              ? { r: 255, g: 255, b: 255, a: 1 }
              : { r: 7, g: 9, b: 12, a: 1 };
            let complex = false;
            for (const current of chain) {
              const style = getComputedStyle(current);
              const background = parseColor(style.backgroundColor);
              if (background && background.a > 0) {
                color = blend(background, color);
                if (background.a >= 0.98) complex = false;
              }
              if (style.backgroundImage !== 'none') complex = true;
            }
            return { color, complex };
          };
          const hasDirectText = (element) => [...element.childNodes].some(
            (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
          );
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
          };

          const contrastFailures = [];
          for (const element of document.querySelectorAll('body *')) {
            if (!hasDirectText(element) || !visible(element)) continue;
            const text = [...element.childNodes]
              .filter((node) => node.nodeType === Node.TEXT_NODE)
              .map((node) => node.textContent?.trim())
              .filter(Boolean)
              .join(' ')
              .slice(0, 100);
            if (!text) continue;
            const style = getComputedStyle(element);
            const foreground = parseColor(style.color);
            if (!foreground || foreground.a === 0) continue;
            const background = effectiveBackground(element);
            const renderedForeground = blend(foreground, background.color);
            const ratio = contrast(renderedForeground, background.color);
            const fontSize = Number.parseFloat(style.fontSize);
            const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
            const largeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
            const threshold = largeText ? 3 : 4.5;
            if (ratio + 0.02 < threshold) {
              contrastFailures.push({
                selector: selector(element),
                text,
                ratio: Number(ratio.toFixed(2)),
                threshold,
                color: style.color,
                background: `rgb(${Math.round(background.color.r)}, ${Math.round(background.color.g)}, ${Math.round(background.color.b)})`,
                complexBackground: background.complex,
              });
            }
          }

          const surfaceMismatches = [];
          const viewportArea = innerWidth * innerHeight;
          for (const element of document.querySelectorAll('body *')) {
            if (!visible(element) || element.closest('.dark-fixed-surface')) continue;
            const rect = element.getBoundingClientRect();
            if (rect.width * rect.height < viewportArea * 0.08) continue;
            const style = getComputedStyle(element);
            const background = parseColor(style.backgroundColor);
            if (!background || background.a < 0.85) continue;
            const lightness = luminance(background);
            if ((expectedTheme === 'light' && lightness < 0.12) || (expectedTheme === 'dark' && lightness > 0.82)) {
              surfaceMismatches.push({ selector: selector(element), background: style.backgroundColor, lightness: Number(lightness.toFixed(3)) });
            }
          }

          return {
            actualTheme: document.documentElement.dataset.theme,
            title: document.title,
            finalUrl: location.href,
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: innerWidth,
            horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
            contrastFailures: contrastFailures.sort((a, b) => a.ratio - b.ratio).slice(0, 80),
            surfaceMismatches: surfaceMismatches.slice(0, 30),
          };
        }, { expectedTheme: theme });

        results.push({
          route,
          viewport: viewportName,
          theme,
          status: response?.status() ?? null,
          navigationError,
          screenshot,
          screenshotError,
          consoleErrors: [...new Set(consoleErrors)].slice(0, 20),
          ...audit,
        });
        process.stdout.write(`${route} ${viewportName} ${theme}: ${audit.contrastFailures.length} contrast, ${audit.horizontalOverflow}px overflow\n`);
        await page.close();
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const reportPath = `${outputDir}/report.json`;
await writeFile(reportPath, `${JSON.stringify({ baseUrl, generatedAt: new Date().toISOString(), results }, null, 2)}\n`);
process.stdout.write(`Report: ${reportPath}\n`);
