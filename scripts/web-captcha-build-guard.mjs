import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const providers = [
  {
    label: 'Turnstile',
    publicName: 'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
    secretName: 'TURNSTILE_SECRET_KEY',
  },
  {
    label: 'hCaptcha',
    publicName: 'NEXT_PUBLIC_HCAPTCHA_SITE_KEY',
    secretName: 'HCAPTCHA_SECRET_KEY',
  },
];

function configured(value) {
  const normalized = value?.trim();
  return Boolean(normalized && normalized !== 'undefined' && normalized !== 'null' && !normalized.startsWith('your-'));
}

export function assertCaptchaKeyPairs(env = process.env) {
  for (const provider of providers) {
    const hasPublic = configured(env[provider.publicName]);
    const hasSecret = configured(env[provider.secretName]);
    if (hasPublic !== hasSecret) {
      throw new Error(`${provider.label} public and secret keys must be configured together before building the web app.`);
    }
  }
}

export async function assertCaptchaPublicKeysEmbedded(staticRoot, env = process.env) {
  const expectedKeys = providers
    .map((provider) => env[provider.publicName]?.trim())
    .filter((value) => configured(value));
  if (expectedKeys.length === 0) return;

  const assets = await listJavaScriptAssets(staticRoot);
  const contents = await Promise.all(assets.map((asset) => readFile(asset, 'utf8')));
  for (const key of expectedKeys) {
    if (!contents.some((content) => content.includes(key))) {
      throw new Error('A configured public CAPTCHA key is missing from the generated client bundle.');
    }
  }
}

async function listJavaScriptAssets(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return listJavaScriptAssets(target);
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  }));
  return nested.flat();
}
