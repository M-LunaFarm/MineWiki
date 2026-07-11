#!/usr/bin/env node

import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const config = require(resolve('infra/pm2/ecosystem.config.cjs'));

const expectedServices = new Map([
  ['minewiki-api', 'api'],
  ['minewiki-worker', 'worker'],
  ['minewiki-bot', 'bot'],
]);

for (const [name, expectedService] of expectedServices) {
  const processConfig = config.apps?.find((app) => app.name === name);
  if (!processConfig) {
    throw new Error(`Missing PM2 process: ${name}`);
  }
  if (processConfig.env?.MINEWIKI_SERVICE !== expectedService) {
    throw new Error(
      `${name} must use MINEWIKI_SERVICE=${expectedService}, got ${String(processConfig.env?.MINEWIKI_SERVICE)}`,
    );
  }
}

const web = config.apps?.find((app) => app.name === 'minewiki-web');
if (!web) {
  throw new Error('Missing PM2 process: minewiki-web');
}
if (web.env?.MINEWIKI_SERVICE) {
  throw new Error('minewiki-web must not impersonate an API, worker, or bot service');
}

console.log('PM2 service labels are valid.');
