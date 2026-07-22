import Module from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { assertReleaseKey, SERVICE_DEFINITIONS, sha256Directory, sha256File, sha256WorkspacePackage } from './service-release-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = process.env.MINEWIKI_SERVICE?.trim();
if (!service || !Object.hasOwn(SERVICE_DEFINITIONS, service)) {
  throw new Error(`MINEWIKI_SERVICE must be one of: ${Object.keys(SERVICE_DEFINITIONS).join(', ')}.`);
}

const releasesRoot = path.join(repoRoot, '.releases/services');
const releaseRoot = realpathSync(path.join(releasesRoot, 'current'));
assertReleaseKey(path.basename(releaseRoot));
if (!releaseRoot.startsWith(`${releasesRoot}${path.sep}`)) {
  throw new Error('Current service release escapes the releases directory.');
}
const manifest = JSON.parse(readFileSync(path.join(releaseRoot, 'release.json'), 'utf8'));
if (await sha256File(path.join(repoRoot, 'pnpm-lock.yaml')) !== manifest.dependencyLockSha256) {
  throw new Error('Service release dependency lock checksum mismatch. Prepare a new service release.');
}
const serviceManifest = manifest.services?.[service];
if (!serviceManifest || serviceManifest.appRoot !== SERVICE_DEFINITIONS[service].appRoot) {
  throw new Error(`Service release manifest is invalid for ${service}.`);
}

const entrypoint = path.resolve(releaseRoot, serviceManifest.appRoot, serviceManifest.entrypoint);
if (!entrypoint.startsWith(`${releaseRoot}${path.sep}`) || !existsSync(entrypoint)) {
  throw new Error(`Service release entrypoint is invalid for ${service}.`);
}
if (await sha256File(entrypoint) !== serviceManifest.entrypointSha256) {
  throw new Error(`Service release entrypoint checksum mismatch for ${service}.`);
}
if (serviceManifest.distSha256
  && await sha256Directory(path.join(releaseRoot, serviceManifest.appRoot, 'dist')) !== serviceManifest.distSha256) {
  throw new Error(`Service release tree checksum mismatch for ${service}.`);
}
if (manifest.workspacePackageSha256 && typeof manifest.workspacePackageSha256 === 'object') {
  for (const [packageName, expectedSha256] of Object.entries(manifest.workspacePackageSha256)) {
    if (!/^[a-z0-9-]+$/u.test(packageName) || typeof expectedSha256 !== 'string') {
      throw new Error('Service release workspace checksum manifest is invalid.');
    }
    const packageRoot = path.join(releaseRoot, 'packages', packageName);
    if (!packageRoot.startsWith(`${path.join(releaseRoot, 'packages')}${path.sep}`)
      || !existsSync(packageRoot)
      || await sha256WorkspacePackage(packageRoot) !== expectedSha256) {
      throw new Error(`Service release workspace checksum mismatch for @minewiki/${packageName}.`);
    }
  }
}

const externalModulePaths = [
  path.join(repoRoot, serviceManifest.appRoot, 'node_modules'),
  path.join(repoRoot, 'node_modules'),
];
process.env.NODE_PATH = [...externalModulePaths, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();
process.chdir(path.join(releaseRoot, serviceManifest.appRoot));
await import(pathToFileURL(entrypoint).href);
