import { chromium, type Browser, type BrowserContextOptions } from 'playwright-core';
import { pool } from '../src/db.js';
import { actorCookie, type AuditUsers, type RouteCheck } from './audit-route-helpers.js';
import { auditRouteSet, auditUsers } from './audit-route-catalog.js';

type RenderAuditOptions = {
  label: 'Mobile' | 'Desktop';
  overflowLabel: string;
  context: BrowserContextOptions;
  theme: 'light' | 'dark';
  requireDesktopNav?: boolean;
  requireMobileMenu?: boolean;
  minTargetSize?: number;
};

type RenderMetrics = {
  url: string;
  overflowX: number;
  hasTopbar: boolean;
  hasDesktopNav: boolean;
  hasIntentStrip: boolean;
  hasMobileMenu: boolean;
  hasFooter: boolean;
  hasMain: boolean;
  h1: string;
  hasUserChip: boolean;
  hasAdminChip: boolean;
  rolePurposePanels: Array<{ selector: string; text: string }>;
  actionControls: Array<{ tag: string; label: string }>;
  contrastIssues: unknown[];
  deadLinks: unknown[];
  formIssues: unknown[];
  disabledWithoutReason: unknown[];
  unlabeledControls: unknown[];
  smallTargets: unknown[];
};

const baseUrl = (process.env.MINEWIKI_AUDIT_BASE ?? 'http://127.0.0.1:3026').replace(/\/$/, '');
const chromePath = process.env.CHROME_BIN ?? '/usr/bin/google-chrome-stable';

export async function runRenderAudit(options: RenderAuditOptions) {
  const failures: string[] = [];
  const fail = (label: string, message: string) => failures.push(`${label}: ${message}`);

  try {
    const users = await auditUsers();
    const routes = await auditRouteSet(users);
    const browser = await chromium.launch({
      executablePath: chromePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    try {
      for (const route of routes) {
        await auditRoute(browser, route, users, options, fail);
      }
    } finally {
      await browser.close();
    }
    if (failures.length) {
      console.error(`${options.label} render audit failed for ${failures.length} checks:`);
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
    } else {
      console.log(`${options.label} render audit passed: ${routes.length} routes at ${baseUrl}`);
    }
  } finally {
    await pool.end();
  }
}

function routeLabel(route: RouteCheck) {
  return `${route.actor ?? 'anonymous'} ${route.path}`;
}

function cookieValue(route: RouteCheck, users: AuditUsers) {
  const cookie = actorCookie(route, users);
  return cookie ? cookie.replace(/^uid=/, '') : null;
}

async function auditRoute(
  browser: Browser,
  route: RouteCheck,
  users: AuditUsers,
  options: RenderAuditOptions,
  fail: (label: string, message: string) => void
) {
  const label = routeLabel(route);
  const context = await browser.newContext(options.context);
  const value = cookieValue(route, users);
  if (value) {
    await context.addCookies([{ name: 'uid', value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' }]);
  }
  await context.addInitScript("Object.defineProperty(globalThis, '__name', { value: (target) => target, configurable: true });");
  await context.addInitScript(`(() => {
    const theme = ${JSON.stringify(options.theme)};
    const applyTheme = () => {
      localStorage.setItem('theme', theme);
      if (document.documentElement) document.documentElement.dataset.theme = theme;
    };
    applyTheme();
    document.addEventListener('DOMContentLoaded', applyTheme, { once: true });
  })();`);

  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 240));
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message.slice(0, 240));
  });
  try {
    const response = await page.goto(`${baseUrl}${route.path}`, { waitUntil: 'networkidle' });
    const status = response?.status() ?? 0;
    const allowedStatuses = route.statuses ?? [200];
    if (!allowedStatuses.includes(status)) fail(label, `status ${status}, expected ${allowedStatuses.join('|')}`);
    await page.evaluate('globalThis.__name = (target) => target');
    const metrics = await page.evaluate<RenderMetrics, { theme: string; minTargetSize: number }>((auditOptions) => {
      document.documentElement.dataset.theme = auditOptions.theme;

      const parseColor = (value: string) => {
        const match = value.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d?(?:\.\d+)?))?\s*\)$/i);
        if (!match) return null;
        return {
          r: Math.max(0, Math.min(255, Number(match[1]))),
          g: Math.max(0, Math.min(255, Number(match[2]))),
          b: Math.max(0, Math.min(255, Number(match[3]))),
          a: match[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(match[4])))
        };
      };
      const relativeLuminance = (color: { r: number; g: number; b: number }) => {
        const channel = (part: number) => {
          const normalized = part / 255;
          return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
      };
      const contrastRatio = (foreground: { r: number; g: number; b: number }, background: { r: number; g: number; b: number }) => {
        const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
        const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
        return (lighter + 0.05) / (darker + 0.05);
      };
      const isVisibleElement = (element: Element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && box.width > 0 && box.height > 0;
      };
      const visible = (selector: string) => {
        const element = document.querySelector(selector);
        return Boolean(element && isVisibleElement(element));
      };
      const blendColor = (
        foreground: { r: number; g: number; b: number; a: number },
        background: { r: number; g: number; b: number; a: number }
      ) => {
        const alpha = foreground.a + background.a * (1 - foreground.a);
        if (alpha <= 0) return { r: 255, g: 255, b: 255, a: 1 };
        return {
          r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
          g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
          b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
          a: alpha
        };
      };
      const effectiveBackground = (element: Element) => {
        const colors: Array<{ r: number; g: number; b: number; a: number }> = [];
        let current: Element | null = element;
        while (current) {
          const color = parseColor(getComputedStyle(current).backgroundColor);
          if (color && color.a > 0) colors.push(color);
          current = current.parentElement;
        }
        const bodyColor = parseColor(getComputedStyle(document.body).backgroundColor);
        const rootColor = parseColor(getComputedStyle(document.documentElement).backgroundColor);
        if (bodyColor && bodyColor.a > 0) colors.push(bodyColor);
        if (rootColor && rootColor.a > 0) colors.push(rootColor);
        let blended = { r: 255, g: 255, b: 255, a: 1 };
        for (const color of colors.reverse()) blended = blendColor(color, blended);
        return blended;
      };
      const auditTextRoots = [...document.querySelectorAll('.topbar, .page-intent-strip, main, .site-footer')];
      const visibleTextNodes = auditTextRoots.flatMap((root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes: Element[] = [];
        let node = walker.nextNode();
        while (node) {
          const text = String(node.textContent ?? '').replace(/\s+/g, ' ').trim();
          const parent = node.parentElement;
          if (text && parent && !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(parent.tagName)) nodes.push(parent);
          node = walker.nextNode();
        }
        return nodes;
      }).filter((element, index, elements) => elements.indexOf(element) === index).filter((element) => {
        const style = getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return (element.textContent ?? '').trim().length > 0
          && style.visibility !== 'hidden'
          && style.display !== 'none'
          && box.width > 0
          && box.height > 0;
      });
      const contrastIssues = visibleTextNodes
        .map((element) => {
          const style = getComputedStyle(element);
          const foreground = parseColor(style.color);
          const background = effectiveBackground(element);
          if (!foreground || foreground.a < 0.8) return null;
          const ratio = contrastRatio(foreground, background);
          const fontSize = Number.parseFloat(style.fontSize || '16');
          const fontWeight = Number.parseInt(style.fontWeight || '400', 10);
          const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
          const minimum = isLargeText ? 3 : 4.5;
          if (ratio >= minimum) return null;
          return {
            tag: element.tagName,
            className: String(element.getAttribute('class') ?? ''),
            text: String(element.textContent ?? '').trim().slice(0, 48),
            color: style.color,
            background: getComputedStyle(element).backgroundColor,
            effectiveBackground: `rgb(${Math.round(background.r)}, ${Math.round(background.g)}, ${Math.round(background.b)})`,
            ratio: Number(ratio.toFixed(2)),
            minimum
          };
        })
        .filter((issue) => Boolean(issue))
        .slice(0, 5);
      const visiblePseudoTextNodes = auditTextRoots.flatMap((root) => [...root.querySelectorAll('*')])
        .filter(isVisibleElement)
        .flatMap((element) => ['::before', '::after'].map((pseudo) => ({ element, pseudo })))
        .filter(({ element, pseudo }) => {
          const style = getComputedStyle(element, pseudo);
          const content = String(style.content ?? '').trim();
          return content !== '' && content !== 'none' && content !== 'normal'
            && style.visibility !== 'hidden'
            && style.display !== 'none';
        });
      const pseudoContrastIssues = visiblePseudoTextNodes
        .map(({ element, pseudo }) => {
          const style = getComputedStyle(element, pseudo);
          const foreground = parseColor(style.color);
          let background = effectiveBackground(element);
          const pseudoBackground = parseColor(style.backgroundColor);
          if (pseudoBackground && pseudoBackground.a > 0) background = blendColor(pseudoBackground, background);
          if (!foreground || foreground.a < 0.8) return null;
          const ratio = contrastRatio(foreground, background);
          const fontSize = Number.parseFloat(style.fontSize || '16');
          const fontWeight = Number.parseInt(style.fontWeight || '400', 10);
          const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
          const minimum = isLargeText ? 3 : 4.5;
          if (ratio >= minimum) return null;
          return {
            tag: `${element.tagName}${pseudo}`,
            className: String(element.getAttribute('class') ?? ''),
            text: String(style.content ?? '').replace(/^["']|["']$/g, '').slice(0, 48),
            color: style.color,
            background: style.backgroundColor,
            effectiveBackground: `rgb(${Math.round(background.r)}, ${Math.round(background.g)}, ${Math.round(background.b)})`,
            ratio: Number(ratio.toFixed(2)),
            minimum
          };
        })
        .filter((issue) => Boolean(issue))
        .slice(0, 5);
      const labelFor = (element: Element) => String(element.textContent ?? element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.tagName)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 48);
      const controlName = (element: Element) => {
        const ariaLabel = String(element.getAttribute('aria-label') ?? '').trim();
        if (ariaLabel) return ariaLabel;
        const labelledBy = String(element.getAttribute('aria-labelledby') ?? '').trim();
        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? '')
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (text) return text;
        }
        const id = String(element.getAttribute('id') ?? '').trim();
        if (id) {
          const externalLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          if (externalLabel) return externalLabel;
        }
        const parentLabel = element.closest('label')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        if (parentLabel) return parentLabel;
        const tableCellLabel = element.closest('[data-label]')?.getAttribute('data-label')?.trim() ?? '';
        if (tableCellLabel) return tableCellLabel;
        const title = String(element.getAttribute('title') ?? '').trim();
        if (title) return title;
        const placeholder = String(element.getAttribute('placeholder') ?? '').trim();
        if (placeholder) return placeholder;
        if (element instanceof HTMLSelectElement) {
          return element.selectedOptions[0]?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        }
        return '';
      };
      const deadLinks = [...document.querySelectorAll('main a[href], .page-intent-strip a[href], .topbar a[href], .site-footer a[href]')]
        .filter(isVisibleElement)
        .map((link) => ({ href: String(link.getAttribute('href') ?? ''), label: labelFor(link) }))
        .filter((link) => {
          const href = link.href.trim();
          if (!href || href === '#' || href.toLowerCase().startsWith('javascript:')) return true;
          if (href.includes('undefined') || href.includes('[object Object]')) return true;
          return false;
        })
        .slice(0, 5);
      const formIssues = [...document.querySelectorAll('main form')]
        .filter(isVisibleElement)
        .map((form) => {
          const action = String(form.getAttribute('action') ?? location.pathname + location.search).trim();
          const method = String(form.getAttribute('method') ?? 'get').toLowerCase();
          const hasSubmit = Boolean(form.querySelector('button, input[type="submit"], input[type="button"]'));
          if (!action || action === '#' || action.toLowerCase().startsWith('javascript:')) return { action, method, issue: 'invalid action' };
          if (!['get', 'post', 'dialog'].includes(method)) return { action, method, issue: 'invalid method' };
          if (!hasSubmit) return { action, method, issue: 'missing submit control' };
          return null;
        })
        .filter((issue) => Boolean(issue))
        .slice(0, 5);
      const unlabeledControls = [...document.querySelectorAll('main input:not([type="hidden"]), main textarea, main select')]
        .filter(isVisibleElement)
        .filter((element) => {
          const type = String(element.getAttribute('type') ?? '').toLowerCase();
          return !['button', 'submit', 'reset', 'image'].includes(type);
        })
        .map((element) => {
          const name = controlName(element);
          if (name) return null;
          return {
            tag: element.tagName,
            type: String(element.getAttribute('type') ?? ''),
            name: String(element.getAttribute('name') ?? ''),
            placeholder: String(element.getAttribute('placeholder') ?? '').slice(0, 48)
          };
        })
        .filter((issue) => Boolean(issue))
        .slice(0, 5);
      const minTargetSize = auditOptions.minTargetSize;
      const targetSelector = [
        '.topbar a[href]',
        '.topbar button',
        '.topbar summary',
        '.page-intent-strip a[href]',
        '.mobile-menu a[href]',
        '.mobile-menu button',
        '.mobile-menu summary',
        'main button:not(:disabled)',
        'main input:not([type="hidden"]):not(:disabled)',
        'main textarea:not(:disabled)',
        'main select:not(:disabled)',
        'main summary',
        'main a.button',
        'main .button',
        'main [role="button"]',
        'main .article-actions a[href]',
        'main .filter-chips a[href]',
        'main .recent-quick-filters a[href]',
        'main .public-info-tabs a[href]',
        'main .user-quick-links a[href]',
        'main .change-actions a[href]',
        'main .subwiki-home-links a[href]',
        'main .subwiki-category-grid a[href]'
      ].join(', ');
      const smallTargets = minTargetSize > 0
        ? [...document.querySelectorAll(targetSelector)]
          .filter(isVisibleElement)
          .map((element) => {
            const type = String(element.getAttribute('type') ?? '').toLowerCase();
            if (['checkbox', 'radio'].includes(type)) return null;
            const box = element.getBoundingClientRect();
            const width = Math.round(box.width);
            const height = Math.round(box.height);
            if (width >= minTargetSize && height >= minTargetSize) return null;
            return {
              tag: element.tagName,
              className: String(element.getAttribute('class') ?? ''),
              label: labelFor(element),
              width,
              height,
              minimum: minTargetSize
            };
          })
          .filter((issue) => Boolean(issue))
          .slice(0, 5)
        : [];
      const disabledWithoutReason = [...document.querySelectorAll('main input:disabled, main textarea:disabled, main select:disabled, main button:disabled, main [aria-disabled="true"]')]
        .filter(isVisibleElement)
        .map((element) => {
          const describedBy = String(element.getAttribute('aria-describedby') ?? '').trim();
          const title = String(element.getAttribute('title') ?? '').trim();
          const described = describedBy ? describedBy.split(/\s+/).every((id) => Boolean(id && document.getElementById(id))) : true;
          if (title && described) return null;
          return { tag: element.tagName, label: labelFor(element), title, describedBy, described };
        })
        .filter((issue) => Boolean(issue))
        .slice(0, 5);
      const rolePurposeSelector = [
        '.admin-hero',
        '.operator-head',
        '.directory-head',
        '.task-summary',
        '.watchlist-summary',
        '.user-dashboard-head',
        '.my-server-summary',
        '.operator-flow-summary',
        '.operator-summary',
        '.audit-summary',
        '.admin-file-summary',
        '.creation-flow-summary',
        '.data-list-head',
        '.public-info-head',
        '.message-page',
        '.doc-status'
      ].join(', ');
      const rolePurposePanels = [...document.querySelectorAll(rolePurposeSelector)]
        .filter(isVisibleElement)
        .map((element) => ({
          selector: String(element.getAttribute('class') ?? element.tagName),
          text: labelFor(element)
        }))
        .slice(0, 5);
      const actionControls = [...document.querySelectorAll('main a[href], main button:not(:disabled), main input[type="submit"]:not(:disabled)')]
        .filter(isVisibleElement)
        .map((element) => ({ tag: element.tagName, label: labelFor(element) }))
        .filter((control) => control.label.length > 0)
        .slice(0, 8);

      return {
        url: location.pathname + location.search,
        overflowX: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
        hasTopbar: visible('.topbar.nav-wrapper'),
        hasDesktopNav: visible('.desktop-nav'),
        hasIntentStrip: visible('.page-intent-strip'),
        hasMobileMenu: visible('.mobile-menu'),
        hasFooter: visible('.site-footer'),
        hasMain: Boolean(document.querySelector('main')),
        h1: document.querySelector('h1')?.textContent?.trim() ?? '',
        hasUserChip: Boolean(document.querySelector('.user-chip')),
        hasAdminChip: Boolean(document.querySelector('.admin-mode-chip')),
        rolePurposePanels,
        actionControls,
        contrastIssues: [...contrastIssues, ...pseudoContrastIssues].slice(0, 5),
        deadLinks,
        formIssues,
        disabledWithoutReason,
        unlabeledControls,
        smallTargets
      };
    }, { theme: options.theme, minTargetSize: options.minTargetSize ?? 0 });

    if (route.finalPath && !route.finalPath.test(metrics.url)) fail(label, `final path ${metrics.url} did not match ${route.finalPath}`);
    if (metrics.overflowX > 2) fail(label, `${options.overflowLabel} horizontal overflow ${metrics.overflowX}px`);
    if (!metrics.hasTopbar) fail(label, `missing ${options.requireDesktopNav ? 'visible ' : ''}topbar`);
    if (options.requireDesktopNav && !metrics.hasDesktopNav) fail(label, 'missing visible desktop nav');
    if (!metrics.hasIntentStrip) fail(label, `missing ${options.requireDesktopNav ? 'visible ' : ''}page intent strip`);
    if (options.requireMobileMenu && !metrics.hasMobileMenu) fail(label, 'missing mobile menu');
    if (!metrics.hasFooter) fail(label, `missing ${options.requireDesktopNav ? 'visible ' : ''}footer`);
    if (!metrics.hasMain) fail(label, 'missing main landmark');
    if (!metrics.h1) fail(label, 'missing visible h1');
    if (route.actor === 'member' && !metrics.hasUserChip) fail(label, 'missing user chip');
    if (route.actor === 'admin' && !metrics.hasAdminChip && !metrics.hasUserChip) fail(label, 'missing authenticated chrome');
    if ((route.actor === 'member' || route.actor === 'admin') && metrics.rolePurposePanels.length === 0) {
      fail(label, 'missing role workflow purpose panel');
    }
    if ((route.actor === 'member' || route.actor === 'admin') && metrics.actionControls.length === 0) {
      fail(label, 'missing visible role action controls');
    }
    if (metrics.contrastIssues.length) fail(label, `low contrast text ${JSON.stringify(metrics.contrastIssues)}`);
    if (metrics.deadLinks.length) fail(label, `dead links ${JSON.stringify(metrics.deadLinks)}`);
    if (metrics.formIssues.length) fail(label, `form affordance issues ${JSON.stringify(metrics.formIssues)}`);
    if (metrics.disabledWithoutReason.length) fail(label, `disabled controls without reason ${JSON.stringify(metrics.disabledWithoutReason)}`);
    if (metrics.unlabeledControls.length) fail(label, `unlabeled form controls ${JSON.stringify(metrics.unlabeledControls)}`);
    if (metrics.smallTargets.length) fail(label, `small interactive targets ${JSON.stringify(metrics.smallTargets)}`);
    const unexpectedConsoleErrors = consoleErrors.filter((message) => !allowedStatuses.includes(status) || !message.includes(`status of ${status}`));
    if (unexpectedConsoleErrors.length) fail(label, `browser console errors ${JSON.stringify(unexpectedConsoleErrors.slice(0, 3))}`);
    if (pageErrors.length) fail(label, `browser page errors ${JSON.stringify(pageErrors.slice(0, 3))}`);
    const html = await page.content();
    for (const needle of route.mustInclude ?? []) {
      if (!html.includes(needle)) fail(label, `missing ${needle}`);
    }
  } finally {
    await context.close();
  }
}
