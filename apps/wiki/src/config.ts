import 'dotenv/config';

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3015),
  baseUrl: process.env.BASE_URL ?? 'http://127.0.0.1:3015',
  supportEmail: process.env.SUPPORT_EMAIL ?? 'support@minewiki.kr',
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'mwiki'
  },
  cookieSecret: process.env.COOKIE_SECRET ?? 'dev-secret-change-me',
  cdnRoot: process.env.CDN_ROOT ?? '/var/www/creepr-cdn',
  cdnPublicUrl: process.env.CDN_PUBLIC_URL ?? '/cdn',
  turnstile: {
    siteKey: process.env.TURNSTILE_SITE_KEY ?? '',
    secretKey: process.env.TURNSTILE_SECRET_KEY ?? ''
  },
  gmail: {
    clientId: process.env.GMAIL_CLIENT_ID ?? '',
    clientSecret: process.env.GMAIL_CLIENT_SECRET ?? '',
    refreshToken: process.env.GMAIL_REFRESH_TOKEN ?? '',
    redirectUri: process.env.GMAIL_REDIRECT_URI ?? 'http://localhost',
    senderEmail: process.env.GMAIL_SENDER_EMAIL ?? process.env.MAIL_FROM ?? 'support@minewiki.kr',
    senderName: process.env.GMAIL_SENDER_NAME ?? 'MineWiki'
  },
  emailVerification: {
    expiresHours: Number(process.env.EMAIL_VERIFICATION_EXPIRES_HOURS ?? 24)
  },
  rendererVersion: 'bwm-0.3.0'
};
