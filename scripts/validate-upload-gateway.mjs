#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const nginxFiles = [
  'infra/nginx/container.conf',
  'infra/nginx/minewiki.conf',
  'infra/nginx/minewiki.routes.conf',
];

const exampleEnvironment = await readFile('.env.example', 'utf8');
if (exampleEnvironment.includes('apps/cdn')) {
  throw new Error('.env.example must not send new uploads to the retired legacy CDN.');
}

for (const file of nginxFiles) {
  const source = await readFile(file, 'utf8');
  if (/location \/cdn\//.test(source) || source.includes('apps/cdn')) {
    throw new Error(`${file} must not expose the retired legacy CDN.`);
  }
  const healthLocation = source.match(/location = \/api\/health\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  if (!healthLocation?.includes('proxy_pass http://minewiki_api/health;')) {
    throw new Error(`${file} must proxy /api/health to the API /health endpoint.`);
  }
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
