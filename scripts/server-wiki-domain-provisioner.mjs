#!/usr/bin/env node

import './load-environment.mjs';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  certificateNeedsRenewal,
  deriveProvisionerToken,
  normalizeProvisionedHostname,
  renderNginxConfiguration,
} from './server-wiki-domain-provisioner-lib.mjs';

const apiBaseUrl = requiredUrl('INTERNAL_API_BASE_URL');
const certbotEmail = required('SERVER_WIKI_CERTBOT_EMAIL');
const token = deriveProvisionerToken(required('APP_ENCRYPTION_KEY'));
const nginxConfig = process.env.SERVER_WIKI_NGINX_CONFIG?.trim()
  || '/etc/nginx/conf.d/minewiki-server-wiki-domains.conf';
const webroot = process.env.SERVER_WIKI_CERTBOT_WEBROOT?.trim() || '/var/lib/letsencrypt';
const webUpstream = process.env.SERVER_WIKI_WEB_UPSTREAM?.trim() || 'http://127.0.0.1:4320';
const apiUpstream = process.env.SERVER_WIKI_API_UPSTREAM?.trim() || 'http://127.0.0.1:4321';

await mkdir(webroot, { recursive: true, mode: 0o755 });
await mkdir(path.dirname(nginxConfig), { recursive: true, mode: 0o755 });

await postInternal('/v1/internal/wiki-domain-provisioning/revalidate?limit=100');
let domains = await listDomains();

// Publish exact HTTP challenge vhosts before asking Certbot to validate them.
const initiallyReadyDomains = [];
for (const domain of routableDomains(domains)) {
  initiallyReadyDomains.push({ ...domain, tlsReady: await certificateReady(domain.hostname) });
}
await publishConfiguration(initiallyReadyDomains);

for (const domain of domains) {
  const hostname = normalizeProvisionedHostname(domain.hostname);
  if (!['verified', 'provisioning', 'active'].includes(domain.status)) continue;
  const allowed = await fetch(new URL(`/v1/wiki/domain-routes/${encodeURIComponent(hostname)}/tls-allowed`, apiBaseUrl), {
    headers: { accept: 'application/json' },
  });
  if (allowed.status !== 204) {
    console.warn(`[domain-provisioner] skipped ${hostname}: routing authorization returned ${allowed.status}`);
    continue;
  }
  if (await needsCertificate(hostname)) {
    try {
      await run('/usr/bin/certbot', [
        'certonly', '--webroot', '--webroot-path', webroot,
        '--cert-name', hostname, '-d', hostname,
        '--non-interactive', '--agree-tos', '--email', certbotEmail,
        '--keep-until-expiring', '--preferred-challenges', 'http',
      ]);
    } catch (error) {
      console.error(`[domain-provisioner] certificate issuance failed for ${hostname}: ${message(error)}`);
    }
  }
}

domains = await listDomains();
const readyDomains = [];
for (const domain of routableDomains(domains)) {
  readyDomains.push({ ...domain, tlsReady: await certificateReady(domain.hostname) });
}
await publishConfiguration(readyDomains);

for (const domain of readyDomains) {
  if (!domain.tlsReady || !['verified', 'provisioning'].includes(domain.status)) continue;
  try {
    await postInternal(`/v1/internal/wiki-domain-provisioning/${encodeURIComponent(domain.hostname)}/activate?expectedVersion=${domain.version}`);
    console.log(`[domain-provisioner] activated ${domain.hostname}`);
  } catch (error) {
    console.error(`[domain-provisioner] activation failed for ${domain.hostname}: ${message(error)}`);
  }
}

async function listDomains() {
  const items = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: '500' });
    if (cursor) query.set('cursor', cursor);
    const page = await getInternal(`/v1/internal/wiki-domain-provisioning/domains?${query}`);
    if (!Array.isArray(page.items)) throw new Error('Domain provisioning API returned an invalid page.');
    items.push(...page.items);
    cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
  } while (cursor);
  return items;
}

function routableDomains(domains) {
  return domains.filter((domain) => ['verified', 'provisioning', 'active'].includes(domain.status));
}

async function publishConfiguration(domains) {
  const rendered = renderNginxConfiguration({ domains, webroot, webUpstream, apiUpstream });
  const previous = await readFile(nginxConfig, 'utf8').catch(() => null);
  await writeAtomic(nginxConfig, rendered);
  try {
    await run('/usr/sbin/nginx', ['-t']);
    await run('/usr/bin/systemctl', ['reload', 'nginx.service']);
  } catch (error) {
    if (previous !== null) await writeAtomic(nginxConfig, previous);
    else await rm(nginxConfig, { force: true });
    throw error;
  }
}

async function needsCertificate(hostname) {
  const fullchain = `/etc/letsencrypt/live/${normalizeProvisionedHostname(hostname)}/fullchain.pem`;
  try {
    return certificateNeedsRenewal(await readFile(fullchain, 'utf8'));
  } catch {
    return true;
  }
}

async function certificateReady(hostname) {
  const normalized = normalizeProvisionedHostname(hostname);
  try {
    const fullchain = `/etc/letsencrypt/live/${normalized}/fullchain.pem`;
    const [pem] = await Promise.all([
      readFile(fullchain, 'utf8'),
      access(fullchain, fsConstants.R_OK),
      access(`/etc/letsencrypt/live/${normalized}/privkey.pem`, fsConstants.R_OK),
    ]);
    return !certificateNeedsRenewal(pem, Date.now(), 0);
  } catch {
    return false;
  }
}

async function getInternal(endpoint) {
  return internalRequest(endpoint, 'GET');
}

async function postInternal(endpoint) {
  return internalRequest(endpoint, 'POST');
}

async function internalRequest(endpoint, method) {
  const response = await fetch(new URL(endpoint, apiBaseUrl), {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${method} ${endpoint} returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  if (response.status === 204) return null;
  return response.json();
}

async function writeAtomic(target, content) {
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o644 });
  await rename(temporary, target);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredUrl(name) {
  const parsed = new URL(required(name));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${name} must use HTTP or HTTPS.`);
  return parsed;
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
