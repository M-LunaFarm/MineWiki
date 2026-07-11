#!/usr/bin/env node

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const webBaseUrl = normalizeBaseUrl(process.env.SMOKE_WEB_BASE_URL ?? 'http://127.0.0.1:4311');
const apiBaseUrl = normalizeBaseUrl(process.env.SMOKE_API_BASE_URL ?? 'http://127.0.0.1:3000');

const checks = [
  {
    name: 'web home',
    url: `${webBaseUrl}/`,
    expectedStatuses: [200],
  },
  {
    name: 'wiki page',
    url: `${webBaseUrl}/wiki/대문`,
    expectedStatuses: [200],
  },
  {
    name: 'servers page',
    url: `${webBaseUrl}/servers`,
    expectedStatuses: [200],
  },
  {
    name: 'api health',
    url: `${apiBaseUrl}/health`,
    expectedStatuses: [200],
  },
  {
    name: 'api readiness',
    url: `${apiBaseUrl}/ready`,
    expectedStatuses: [200],
  },
  {
    name: 'auth providers',
    url: `${apiBaseUrl}/v1/auth/providers`,
    expectedStatuses: [200],
  },
  {
    name: 'api wiki page',
    url: `${apiBaseUrl}/v1/wiki/page/by-path?path=${encodeURIComponent('/wiki/대문')}`,
    expectedStatuses: [200],
  },
  {
    name: 'proxied api wiki page',
    url: `${webBaseUrl}/api/v1/wiki/page/by-path?path=${encodeURIComponent('/wiki/대문')}`,
    expectedStatuses: [200],
  },
  {
    name: 'proxied api readiness',
    url: `${webBaseUrl}/api/ready`,
    expectedStatuses: [200],
  },
];

if (dryRun) {
  for (const check of checks) {
    console.log(`${check.name}: ${check.url} [${check.expectedStatuses.join(', ')}]`);
  }
  process.exit(0);
}

let failures = 0;

for (const check of checks) {
  try {
    const response = await fetch(check.url, { redirect: 'manual' });
    if (check.expectedStatuses.includes(response.status)) {
      console.log(`ok ${check.name} ${response.status}`);
      continue;
    }
    failures += 1;
    console.error(
      `fail ${check.name}: expected ${check.expectedStatuses.join(', ')}, got ${response.status}`,
    );
  } catch (error) {
    failures += 1;
    console.error(`fail ${check.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures > 0) {
  process.exitCode = 1;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}
