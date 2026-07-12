#!/usr/bin/env node

import './load-environment.mjs';
import { matchesJsonSubset } from './smoke-assertions.mjs';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const webBaseUrl = normalizeBaseUrl(process.env.SMOKE_WEB_BASE_URL ?? 'http://127.0.0.1:4320');
const apiBaseUrl = normalizeBaseUrl(process.env.SMOKE_API_BASE_URL ?? 'http://127.0.0.1:4321');

const checks = [
  {
    name: 'web home',
    url: `${webBaseUrl}/`,
    expectedStatuses: [200],
  },
  {
    name: 'web identity',
    url: `${webBaseUrl}/health`,
    expectedStatuses: [200],
    expectedJson: { status: 'ok', service: 'minewiki-web' },
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
    expectedJson: { status: 'ok', service: 'minewiki-api' },
  },
  {
    name: 'api readiness',
    url: `${apiBaseUrl}/ready`,
    expectedStatuses: [200],
    expectedJson: { status: 'ok', service: 'minewiki-api' },
  },
  {
    name: 'minecraft ownership callback',
    url: `${webBaseUrl}/minecraft/callback`,
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
    expectedJson: { status: 'ok', service: 'minewiki-api' },
  },
];

if (dryRun) {
  for (const check of checks) {
    const jsonExpectation = check.expectedJson
      ? ` json=${JSON.stringify(check.expectedJson)}`
      : '';
    console.log(
      `${check.name}: ${check.url} [${check.expectedStatuses.join(', ')}]${jsonExpectation}`,
    );
  }
  process.exit(0);
}

let failures = 0;

for (const check of checks) {
  try {
    const response = await fetch(check.url, { redirect: 'manual' });
    if (!check.expectedStatuses.includes(response.status)) {
      failures += 1;
      console.error(
        `fail ${check.name}: expected ${check.expectedStatuses.join(', ')}, got ${response.status}`,
      );
      continue;
    }
    if (check.expectedJson) {
      const body = await response.json().catch(() => null);
      if (!matchesJsonSubset(body, check.expectedJson)) {
        failures += 1;
        console.error(
          `fail ${check.name}: response does not identify ${check.expectedJson.service ?? 'the expected service'}`,
        );
        continue;
      }
    }
    console.log(`ok ${check.name} ${response.status}`);
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
