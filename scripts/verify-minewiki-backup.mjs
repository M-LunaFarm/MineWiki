#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertSafeArchiveEntries, resolveSafeDirectory } from './minewiki-backup-contract.mjs';

const snapshot = resolveSafeDirectory(process.argv[2], { label: 'snapshot path' });
const manifestPath = path.join(snapshot, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 1 || manifest.snapshotId !== path.basename(snapshot)) throw new Error('Backup manifest identity is invalid.');
for (const artifact of [manifest.database, manifest.uploads]) {
  const file = path.join(snapshot, artifact.artifact);
  const content = await readFile(file);
  const digest = createHash('sha256').update(content).digest('hex');
  if (content.length !== artifact.size || digest !== artifact.sha256) throw new Error(`Backup checksum mismatch: ${artifact.artifact}`);
}
const entries = await capture('tar', ['--list', '--gzip', '--file', path.join(snapshot, manifest.uploads.artifact)]);
assertSafeArchiveEntries(entries.split('\n').filter(Boolean));
const sqlPrefix = (await readFile(path.join(snapshot, manifest.database.artifact), 'utf8')).slice(0, 4096);
if (!/MySQL dump|MariaDB dump/iu.test(sqlPrefix)) throw new Error('Database artifact is not a recognizable SQL dump.');
manifest.verification = { verifiedAt: new Date().toISOString(), mode: 'checksum-and-archive' };
const temporary = `${manifestPath}.tmp`;
await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, manifestPath);
process.stdout.write(`Verified ${manifest.snapshotId}\n`);

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] }); let output = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited with code ${code}`)));
  });
}
