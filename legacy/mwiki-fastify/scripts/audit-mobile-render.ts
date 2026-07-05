import { runRenderAudit } from './audit-render-shared.js';

await runRenderAudit({
  label: 'Mobile',
  overflowLabel: 'mobile',
  theme: 'dark',
  requireMobileMenu: true,
  minTargetSize: 32,
  context: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    locale: 'ko-KR'
  }
});
