#!/usr/bin/env node

import './load-environment.mjs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveSafeDirectory } from './minewiki-backup-contract.mjs';

export async function findLatestVerifiedSnapshot(root) {
  const candidates = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}Z$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  for (const snapshotId of candidates) {
    const snapshot = path.join(root, snapshotId);
    try {
      const manifest = JSON.parse(await readFile(path.join(snapshot, 'manifest.json'), 'utf8'));
      if (
        manifest.snapshotId === snapshotId
        && typeof manifest.verification?.verifiedAt === 'string'
      ) {
        return snapshot;
      }
    } catch {
      // Preserve corrupt evidence for inspection and continue to the latest valid snapshot.
    }
  }

  throw new Error(`No verified MineWiki backup snapshot exists under ${root}.`);
}

async function main() {
  const backupRoot = resolveSafeDirectory(
    process.env.MINEWIKI_BACKUP_ROOT || '/var/backups/minewiki',
    { label: 'MINEWIKI_BACKUP_ROOT' },
  );
  const snapshot = await findLatestVerifiedSnapshot(backupRoot);
  await run(process.execPath, [
    fileURLToPath(new URL('./drill-minewiki-backup.mjs', import.meta.url)),
    snapshot,
  ]);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code) => (
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with code ${code}`))
    ));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

