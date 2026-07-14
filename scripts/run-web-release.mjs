import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseRoot = realpathSync(path.join(repoRoot, '.releases/web/current'));
const manifest = JSON.parse(readFileSync(path.join(releaseRoot, 'release.json'), 'utf8'));
if (!manifest.webCwd || typeof manifest.webCwd !== 'string') {
  throw new Error('Web release manifest is invalid.');
}

const runtimeRoot = path.resolve(releaseRoot, manifest.webCwd);
if (!runtimeRoot.startsWith(`${releaseRoot}${path.sep}`) && runtimeRoot !== releaseRoot) {
  throw new Error('Web release runtime path escapes the immutable release.');
}

process.chdir(runtimeRoot);
await import(pathToFileURL(path.join(runtimeRoot, 'server.js')).href);
