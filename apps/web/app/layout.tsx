import './globals.css';
import 'katex/dist/katex.min.css';

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Inter, Noto_Sans_KR, Noto_Serif_KR, JetBrains_Mono } from 'next/font/google';
import { AuthProvider } from '../components/providers/auth-context';
import { QueryClientProvider } from '../components/providers/query-client-provider';
import { AppShell } from '../components/layout/app-shell';
import { DEFAULT_SITE_DESCRIPTION, SITE_NAME, getSiteUrl } from '../lib/metadata';

export const metadata: Metadata = {
  metadataBase: new URL(getSiteUrl()),
  title: {
    default: SITE_NAME,
    template: `%s | ${SITE_NAME}`,
  },
  description: DEFAULT_SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  appleWebApp: {
    title: SITE_NAME,
  },
  manifest: '/manifest.webmanifest',
  openGraph: {
    title: SITE_NAME,
    description: DEFAULT_SITE_DESCRIPTION,
    url: '/',
    siteName: SITE_NAME,
    locale: 'ko_KR',
    type: 'website',
    images: [{ url: '/og', width: 1200, height: 630, alt: 'MineWiki' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_NAME,
    description: DEFAULT_SITE_DESCRIPTION,
    images: ['/og'],
  },
};

const themeScript = `(() => { try { const saved = localStorage.getItem('minewiki-theme'); const theme = saved === 'light' || saved === 'dark' ? saved : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); document.documentElement.dataset.theme = theme; document.documentElement.style.colorScheme = theme; } catch { document.documentElement.dataset.theme = 'dark'; } })();`;

const displayFont = Inter({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-display',
});

const bodyFont = Noto_Sans_KR({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-body',
});

const editorialFont = Noto_Serif_KR({
  subsets: ['latin'],
  weight: ['600', '700', '900'],
  variable: '--font-editorial',
});

const monoFont = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '600'],
  variable: '--font-mono',
});

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" data-theme="dark" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body
        className={`${displayFont.variable} ${bodyFont.variable} ${editorialFont.variable} ${monoFont.variable} min-h-screen bg-surface-100 font-sans text-slate-100 antialiased`}
      >
        <QueryClientProvider>
          <AuthProvider>
            <AppShell>{children}</AppShell>
          </AuthProvider>
        </QueryClientProvider>
      </body>
    </html>
  );
}
