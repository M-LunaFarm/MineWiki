import { runRenderAudit } from './audit-render-shared.js';

await runRenderAudit({
  label: 'Desktop',
  overflowLabel: 'desktop',
  theme: 'light',
  requireDesktopNav: true,
  minTargetSize: 24,
  context: {
    viewport: { width: 1366, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    colorScheme: 'light',
    locale: 'ko-KR'
  }
});
