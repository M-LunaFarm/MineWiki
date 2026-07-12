#!/usr/bin/env node

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
const verifyWeb = config.apps?.find((app) => app.name === 'minewiki-verify-web');
if (!web) {
  throw new Error('Missing PM2 process: minewiki-web');
}
if (!verifyWeb) {
  throw new Error('Missing PM2 process: minewiki-verify-web');
}
if (web.env?.MINEWIKI_SERVICE) {
  throw new Error('minewiki-web must not impersonate an API, worker, or bot service');
}

const api = config.apps?.find((app) => app.name === 'minewiki-api');
const webPort = String(web.env?.PORT ?? '');
const verifyWebPort = String(verifyWeb.env?.PORT ?? '');
const apiPort = String(api?.env?.API_PORT ?? '');
if (
  !/^\d+$/.test(webPort) ||
  !/^\d+$/.test(verifyWebPort) ||
  !/^\d+$/.test(apiPort) ||
  new Set([webPort, verifyWebPort, apiPort]).size !== 3
) {
  throw new Error('MineWiki web, verify web, and API must use distinct numeric ports.');
}
if (!web.args?.includes(`-H 127.0.0.1`) || !web.args?.includes(`-p ${webPort}`)) {
  throw new Error('minewiki-web must bind its configured port to loopback.');
}
if (
  !verifyWeb.args?.includes(`-H 127.0.0.1`) ||
  !verifyWeb.args?.includes(`-p ${verifyWebPort}`)
) {
  throw new Error('minewiki-verify-web must bind its configured port to loopback.');
}
if (api?.env?.API_HOST !== '127.0.0.1') {
  throw new Error('minewiki-api must bind to loopback behind Nginx.');
}

const expectedInternalApiBaseUrl = `http://127.0.0.1:${apiPort}`;
for (const name of ['minewiki-web', 'minewiki-verify-web', 'minewiki-api', 'minewiki-bot']) {
  const app = config.apps?.find((candidate) => candidate.name === name);
  if (app?.env?.INTERNAL_API_BASE_URL !== expectedInternalApiBaseUrl) {
    throw new Error(`${name} must use INTERNAL_API_BASE_URL=${expectedInternalApiBaseUrl}`);
  }
}

for (const relativePath of ['infra/nginx/minewiki.conf', 'infra/nginx/minewiki.routes.conf']) {
  const nginxConfig = readFileSync(resolve(relativePath), 'utf8');
  if (!nginxConfig.includes(`server 127.0.0.1:${webPort};`)) {
    throw new Error(`${relativePath} must route MineWiki web to port ${webPort}.`);
  }
  if (!nginxConfig.includes(`server 127.0.0.1:${verifyWebPort};`)) {
    throw new Error(`${relativePath} must route MineWiki verify web to port ${verifyWebPort}.`);
  }
  if (!nginxConfig.includes(`server 127.0.0.1:${apiPort};`)) {
    throw new Error(`${relativePath} must route MineWiki API to port ${apiPort}.`);
  }
}

console.log(
  `PM2 service labels and loopback ports are valid (web=${webPort}, verify=${verifyWebPort}, api=${apiPort}).`,
);
