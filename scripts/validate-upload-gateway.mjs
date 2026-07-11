#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const nginxFiles = [
  'infra/nginx/container.conf',
  'infra/nginx/minewiki.conf',
  'infra/nginx/minewiki.routes.conf',
];

for (const file of nginxFiles) {
  const source = await readFile(file, 'utf8');
  const location = source.match(/location \/uploads\/\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  if (!location) {
    throw new Error(`${file} is missing the /uploads/ location.`);
  }
  if (/\balias\b/.test(location) || /\broot\b/.test(location)) {
    throw new Error(`${file} must not serve uploads directly from the filesystem.`);
  }
  if (!location.includes('/v1/files/public/$1/raw')) {
    throw new Error(`${file} must route upload URLs through FileController.`);
  }
  if (!/proxy_pass\s+http:\/\/minewiki_api/.test(location)) {
    throw new Error(`${file} must proxy upload reads to the API.`);
  }
}

const compose = await readFile('compose.yml', 'utf8');
const gateway = compose.match(/\n  gateway:\n([\s\S]*?)\nvolumes:\n/)?.[1];
if (!gateway) {
  throw new Error('compose.yml is missing the gateway service.');
}
if (/\buploads:\/[^\n]*:ro\b/.test(gateway)) {
  throw new Error('The gateway must not mount the upload storage volume directly.');
}

console.log('Upload gateway routing is permission-aware.');
