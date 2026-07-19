#!/usr/bin/env node

import { constants } from 'node:fs';
import { access, chmod, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';

const OAUTH_KEYS = [
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'NAVER_CLIENT_ID',
  'NAVER_CLIENT_SECRET',
];
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArgs(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

const sourcePath = path.resolve(options.source);
const targetPath = path.resolve(rootDir, options.target);
await assertRegularPrivateTarget(sourcePath, 'VoteWeb OAuth source');
await assertRegularPrivateTarget(targetPath, 'MineWiki environment');

const sourceText = await readFile(sourcePath, 'utf8');
const targetText = await readFile(targetPath, 'utf8');
const source = parseDotenv(sourceText);
const target = parseDotenv(targetText);
const missing = OAUTH_KEYS.filter((key) => !source[key]?.trim());
if (missing.length > 0) {
  throw new Error(`VoteWeb OAuth source is missing required keys: ${missing.join(', ')}`);
}

for (const key of OAUTH_KEYS) {
  const assignments = targetText.match(new RegExp(`^${key}[ \\t]*=`, 'gmu')) ?? [];
  if (assignments.length > 1) throw new Error(`MineWiki environment contains duplicate ${key} assignments.`);
}

const changed = OAUTH_KEYS.filter((key) => target[key] !== source[key]);
if (changed.length === 0) {
  console.log('MineWiki OAuth values already match VoteWeb.');
  process.exit(0);
}
if (options.dryRun) {
  console.log(`OAuth synchronization required for: ${changed.join(', ')}`);
  process.exit(0);
}

let output = targetText;
for (const key of OAUTH_KEYS) {
  const assignment = `${key}=${JSON.stringify(source[key])}`;
  const pattern = new RegExp(`^${key}[ \\t]*=.*$`, 'mu');
  output = pattern.test(output)
    ? output.replace(pattern, assignment)
    : `${output.replace(/\\s*$/u, '')}\n${assignment}\n`;
}

const verified = parseDotenv(output);
for (const key of OAUTH_KEYS) {
  if (verified[key] !== source[key]) throw new Error(`Failed to stage a verified ${key} assignment.`);
}

const temporaryPath = `${targetPath}.oauth-${process.pid}.tmp`;
let handle;
try {
  handle = await open(temporaryPath, 'wx', 0o600);
  await handle.writeFile(output, 'utf8');
  await handle.sync();
  await handle.close();
  handle = undefined;
  await rename(temporaryPath, targetPath);
  await chmod(targetPath, 0o600);
} catch (error) {
  await handle?.close().catch(() => undefined);
  await unlink(temporaryPath).catch(() => undefined);
  throw error;
}

console.log(`Synchronized VoteWeb OAuth keys without printing secrets: ${changed.join(', ')}`);

async function assertRegularPrivateTarget(filePath, label) {
  await access(filePath, constants.R_OK);
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular, non-symlink file.`);
}

function parseArgs(argv) {
  const parsed = {
    source: '/var/www/VoteWeb/.env',
    target: '.env',
    dryRun: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg.startsWith('--source=')) parsed.source = arg.slice('--source='.length);
    else if (arg.startsWith('--target=')) parsed.target = arg.slice('--target='.length);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: pnpm env:sync-voteweb-oauth [--dry-run]

Atomically copies Discord and Naver OAuth client credentials from the existing
VoteWeb environment into the ignored MineWiki environment. Other MineWiki
secrets and settings are preserved, and secret values are never printed.

Options:
  --source=/var/www/VoteWeb/.env
  --target=.env
  --dry-run`);
}
