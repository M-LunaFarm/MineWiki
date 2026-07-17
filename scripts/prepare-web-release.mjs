import { cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = path.join(repoRoot, 'apps/web');
const nextRoot = path.join(webRoot, '.next');
const standaloneRoot = path.join(nextRoot, 'standalone');
const releasesRoot = path.join(repoRoot, '.releases/web');

if (!existsSync(path.join(standaloneRoot, 'server.js')) &&
    !existsSync(path.join(standaloneRoot, 'apps/web/server.js'))) {
  throw new Error('Next standalone output is missing. Run the web production build first.');
}

const buildId = (await readFile(path.join(nextRoot, 'BUILD_ID'), 'utf8')).trim();
if (!/^[A-Za-z0-9_-]{8,128}$/u.test(buildId)) {
  throw new Error('Next BUILD_ID is invalid.');
}

const webCwd = existsSync(path.join(standaloneRoot, 'apps/web/server.js')) ? 'apps/web' : '.';
const releaseKey = `${Date.now()}-${buildId}`;
const releaseRoot = path.join(releasesRoot, releaseKey);
const releaseWebRoot = path.join(releaseRoot, webCwd);
await mkdir(releasesRoot, { recursive: true });
await rm(releaseRoot, { recursive: true, force: true });
await cp(standaloneRoot, releaseRoot, {
  recursive: true,
  force: true,
  verbatimSymlinks: true,
});
await mkdir(path.join(releaseWebRoot, '.next'), { recursive: true });
await cp(path.join(nextRoot, 'static'), path.join(releaseWebRoot, '.next/static'), {
  recursive: true,
  force: true,
});
if (existsSync(path.join(webRoot, 'public'))) {
  await cp(path.join(webRoot, 'public'), path.join(releaseWebRoot, 'public'), {
    recursive: true,
    force: true,
  });
}
await writeFile(
  path.join(releaseRoot, 'release.json'),
  `${JSON.stringify({ buildId, webCwd, createdAt: new Date().toISOString() }, null, 2)}\n`,
  'utf8',
);

const pendingLink = path.join(releasesRoot, `.current-${process.pid}`);
await rm(pendingLink, { force: true });
await symlink(releaseKey, pendingLink);
await rename(pendingLink, path.join(releasesRoot, 'current'));

const releases = (await readdir(releasesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name !== releaseKey)
  .sort((left, right) => right.name.localeCompare(left.name));
// Keep enough immutable releases for every web process to survive a missed
// reload. minewiki.kr and verify.minewiki.kr run as separate PM2 processes.
for (const stale of releases.slice(8)) {
  await rm(path.join(releasesRoot, stale.name), { recursive: true, force: true });
}

console.log(`Prepared immutable web release ${releaseKey} (${webCwd}).`);
