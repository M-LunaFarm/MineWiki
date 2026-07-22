import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const SERVICE_DEFINITIONS = Object.freeze({
  api: Object.freeze({ appRoot: 'apps/api', entrypoint: 'dist/apps/api/src/main.js' }),
  worker: Object.freeze({ appRoot: 'apps/worker', entrypoint: 'dist/apps/worker/src/index.js' }),
  bot: Object.freeze({ appRoot: 'apps/bot', entrypoint: 'dist/apps/bot/src/index.js' }),
});

const RELEASE_KEY_PATTERN = /^\d{13}-[a-f0-9]{12}$/u;

export async function sha256File(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function appendDirectoryHash(hash, root, relativeRoot = '') {
  const directory = path.join(root, relativeRoot);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeRoot.split(path.sep).join('/'), entry.name);
    if (entry.isDirectory()) {
      await appendDirectoryHash(hash, root, relativePath);
      continue;
    }
    if (!entry.isFile()) continue;
    hash.update(relativePath).update('\0').update(await sha256File(path.join(root, relativePath))).update('\0');
  }
}

export async function sha256Directory(root) {
  const hash = createHash('sha256');
  await appendDirectoryHash(hash, root);
  return hash.digest('hex');
}

export async function sha256WorkspacePackage(root) {
  const hash = createHash('sha256');
  const rootEntries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && (entry.name === 'package.json' || /\.(?:c?js|mjs|json)$/u.test(entry.name)))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of rootEntries) {
    hash.update(entry.name).update('\0').update(await sha256File(path.join(root, entry.name))).update('\0');
  }
  const distRoot = path.join(root, 'dist');
  if (existsSync(distRoot)) await appendDirectoryHash(hash, root, 'dist');
  return hash.digest('hex');
}

export function assertReleaseKey(releaseKey) {
  if (!RELEASE_KEY_PATTERN.test(releaseKey)) {
    throw new Error(`Invalid service release key: ${releaseKey}`);
  }
  return releaseKey;
}

async function copyWorkspacePackage(sourceRoot, destinationRoot) {
  await mkdir(destinationRoot, { recursive: true });
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'dist' && entry.isDirectory()) {
      await cp(path.join(sourceRoot, entry.name), path.join(destinationRoot, entry.name), {
        recursive: true,
        force: true,
      });
      continue;
    }
    if (entry.isFile() && (entry.name === 'package.json' || /\.(?:c?js|mjs|json)$/u.test(entry.name))) {
      await cp(path.join(sourceRoot, entry.name), path.join(destinationRoot, entry.name), { force: true });
    }
  }

  const sourceModules = path.join(sourceRoot, 'node_modules');
  if (!existsSync(sourceModules)) return;
  const destinationModules = path.join(destinationRoot, 'node_modules');
  await mkdir(destinationModules, { recursive: true });
  for (const entry of await readdir(sourceModules, { withFileTypes: true })) {
    if (entry.name === '@minewiki' || entry.name.startsWith('.')) continue;
    const sourceDependency = path.join(sourceModules, entry.name);
    await symlink(await realpath(sourceDependency), path.join(destinationModules, entry.name));
  }
}

async function discoverWorkspacePackages(repoRoot) {
  const packages = new Map();
  for (const definition of Object.values(SERVICE_DEFINITIONS)) {
    const scopeRoot = path.join(repoRoot, definition.appRoot, 'node_modules/@minewiki');
    if (!existsSync(scopeRoot)) continue;
    for (const entry of await readdir(scopeRoot, { withFileTypes: true })) {
      if (!entry.isSymbolicLink() && !entry.isDirectory()) continue;
      const sourceRoot = await realpath(path.join(scopeRoot, entry.name));
      if (!sourceRoot.startsWith(`${path.join(repoRoot, 'packages')}${path.sep}`)) {
        throw new Error(`Workspace package @minewiki/${entry.name} resolves outside packages/.`);
      }
      packages.set(entry.name, sourceRoot);
    }
  }
  return packages;
}

export async function prepareServiceRelease(repoRoot, options = {}) {
  const releasesRoot = path.join(repoRoot, '.releases/services');
  const createdAt = options.createdAt ?? new Date();
  const sourceFingerprint = createHash('sha256');
  const serviceManifest = {};
  const dependencyLockSha256 = await sha256File(path.join(repoRoot, 'pnpm-lock.yaml'));
  sourceFingerprint.update(dependencyLockSha256);

  for (const [service, definition] of Object.entries(SERVICE_DEFINITIONS)) {
    const entrypoint = path.join(repoRoot, definition.appRoot, definition.entrypoint);
    if (!existsSync(entrypoint)) {
      throw new Error(`Missing ${service} build output: ${entrypoint}`);
    }
    const entrypointSha256 = await sha256File(entrypoint);
    const distSha256 = await sha256Directory(path.join(repoRoot, definition.appRoot, 'dist'));
    sourceFingerprint.update(service).update(distSha256);
    serviceManifest[service] = { ...definition, entrypointSha256, distSha256 };
  }

  const workspacePackages = await discoverWorkspacePackages(repoRoot);
  const workspacePackageSha256 = {};
  for (const [packageName, sourceRoot] of [...workspacePackages.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const packageSha256 = await sha256WorkspacePackage(sourceRoot);
    workspacePackageSha256[packageName] = packageSha256;
    sourceFingerprint.update(packageName).update(packageSha256);
  }

  const releaseKey = `${createdAt.getTime()}-${sourceFingerprint.digest('hex').slice(0, 12)}`;
  assertReleaseKey(releaseKey);
  const releaseRoot = path.join(releasesRoot, releaseKey);
  await mkdir(releasesRoot, { recursive: true });
  await rm(releaseRoot, { recursive: true, force: true });

  for (const definition of Object.values(SERVICE_DEFINITIONS)) {
    await cp(
      path.join(repoRoot, definition.appRoot, 'dist'),
      path.join(releaseRoot, definition.appRoot, 'dist'),
      { recursive: true, force: true },
    );
  }

  for (const [packageName, sourceRoot] of workspacePackages) {
    const destinationRoot = path.join(releaseRoot, 'packages', packageName);
    await copyWorkspacePackage(sourceRoot, destinationRoot);
    const linkRoot = path.join(releaseRoot, 'node_modules/@minewiki');
    await mkdir(linkRoot, { recursive: true });
    await symlink(path.relative(linkRoot, destinationRoot), path.join(linkRoot, packageName));
  }

  const manifest = {
    releaseKey,
    createdAt: createdAt.toISOString(),
    nodeVersion: process.version,
    dependencyLockSha256,
    services: serviceManifest,
    workspacePackages: [...workspacePackages.keys()].sort(),
    workspacePackageSha256,
  };
  await writeFile(path.join(releaseRoot, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const currentLink = path.join(releasesRoot, 'current');
  let previousReleaseKey = null;
  if (existsSync(currentLink)) {
    previousReleaseKey = assertReleaseKey(path.basename(await readlink(currentLink)));
    const pendingPrevious = path.join(releasesRoot, `.previous-${process.pid}`);
    await rm(pendingPrevious, { force: true });
    await symlink(previousReleaseKey, pendingPrevious);
    await rename(pendingPrevious, path.join(releasesRoot, 'previous'));
  }

  const pendingCurrent = path.join(releasesRoot, `.current-${process.pid}`);
  await rm(pendingCurrent, { force: true });
  await symlink(releaseKey, pendingCurrent);
  await rename(pendingCurrent, currentLink);

  const protectedKeys = new Set([releaseKey, previousReleaseKey].filter(Boolean));
  const releases = (await readdir(releasesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && RELEASE_KEY_PATTERN.test(entry.name) && !protectedKeys.has(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name));
  for (const stale of releases.slice(8)) {
    await rm(path.join(releasesRoot, stale.name), { recursive: true, force: true });
  }

  return manifest;
}

export async function rollbackServiceRelease(repoRoot) {
  const releasesRoot = path.join(repoRoot, '.releases/services');
  const currentLink = path.join(releasesRoot, 'current');
  const previousLink = path.join(releasesRoot, 'previous');
  if (!existsSync(currentLink) || !existsSync(previousLink)) {
    throw new Error('Both current and previous service releases are required for rollback.');
  }
  const currentKey = assertReleaseKey(path.basename(await readlink(currentLink)));
  const previousKey = assertReleaseKey(path.basename(await readlink(previousLink)));
  for (const releaseKey of [currentKey, previousKey]) {
    const releaseStat = await lstat(path.join(releasesRoot, releaseKey));
    if (!releaseStat.isDirectory()) throw new Error(`Service release is not a directory: ${releaseKey}`);
  }

  const pendingCurrent = path.join(releasesRoot, `.current-${process.pid}`);
  const pendingPrevious = path.join(releasesRoot, `.previous-${process.pid}`);
  await rm(pendingCurrent, { force: true });
  await rm(pendingPrevious, { force: true });
  await symlink(previousKey, pendingCurrent);
  await symlink(currentKey, pendingPrevious);
  await rename(pendingPrevious, previousLink);
  await rename(pendingCurrent, currentLink);
  return { current: previousKey, previous: currentKey };
}
