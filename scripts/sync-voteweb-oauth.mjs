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
const MAIL_KEYS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_SECURE',
  'SMTP_FROM',
];
const SYNC_KEYS = [...OAUTH_KEYS, ...MAIL_KEYS];
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

let sourceText = await readFile(sourcePath, 'utf8');
const targetText = await readFile(targetPath, 'utf8');
let source = parseDotenv(sourceText);
const target = parseDotenv(targetText);
const missingMail = MAIL_KEYS.filter((key) => !source[key]?.trim());
if (options.bootstrapMailSource && missingMail.length > 0) {
  const missingTargetMail = MAIL_KEYS.filter((key) => !target[key]?.trim());
  if (missingTargetMail.length > 0) {
    throw new Error(`MineWiki mail bootstrap source is missing required keys: ${missingTargetMail.join(', ')}`);
  }
  sourceText = upsertAssignments(sourceText, MAIL_KEYS, target);
  if (!options.dryRun) await atomicWritePrivate(sourcePath, sourceText, 'mail-source');
  source = parseDotenv(sourceText);
  console.log(`${options.dryRun ? 'VoteWeb mail source bootstrap required for' : 'Bootstrapped VoteWeb mail source without printing secrets'}: ${missingMail.join(', ')}`);
}
const missing = SYNC_KEYS.filter((key) => !source[key]?.trim());
if (missing.length > 0) {
  throw new Error(`VoteWeb auth and mail source is missing required keys: ${missing.join(', ')}`);
}

for (const key of SYNC_KEYS) {
  const assignments = targetText.match(new RegExp(`^${key}[ \\t]*=`, 'gmu')) ?? [];
  if (assignments.length > 1) throw new Error(`MineWiki environment contains duplicate ${key} assignments.`);
}

const changed = SYNC_KEYS.filter((key) => target[key] !== source[key]);
if (changed.length === 0) {
  console.log('MineWiki auth and mail values already match VoteWeb.');
  process.exit(0);
}
if (options.dryRun) {
  console.log(`Auth and mail synchronization required for: ${changed.join(', ')}`);
  process.exit(0);
}

const output = upsertAssignments(targetText, SYNC_KEYS, source);

const verified = parseDotenv(output);
for (const key of SYNC_KEYS) {
  if (verified[key] !== source[key]) throw new Error(`Failed to stage a verified ${key} assignment.`);
}

await atomicWritePrivate(targetPath, output, 'auth-mail');

console.log(`Synchronized VoteWeb auth and mail keys without printing secrets: ${changed.join(', ')}`);

function upsertAssignments(text, keys, values) {
  let output = text;
  for (const key of keys) {
    const assignment = `${key}=${JSON.stringify(values[key])}`;
    const pattern = new RegExp(`^${key}[ \\t]*=.*$`, 'mu');
    output = pattern.test(output)
      ? output.replace(pattern, assignment)
      : `${output.replace(/\\s*$/u, '')}\n${assignment}\n`;
  }
  return output;
}

async function atomicWritePrivate(filePath, contents, label) {
  const temporaryPath = `${filePath}.${label}-${process.pid}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

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
    bootstrapMailSource: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--bootstrap-mail-source') parsed.bootstrapMailSource = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg.startsWith('--source=')) parsed.source = arg.slice('--source='.length);
    else if (arg.startsWith('--target=')) parsed.target = arg.slice('--target='.length);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: pnpm env:sync-voteweb-oauth [--dry-run]

Atomically copies Discord and Naver OAuth plus SMTP mail credentials from the
existing VoteWeb environment into the ignored MineWiki environment. Other
MineWiki secrets and settings are preserved, and secret values are never printed.

Options:
  --source=/var/www/VoteWeb/.env
  --target=.env
  --dry-run
  --bootstrap-mail-source  One-time recovery: copy missing SMTP keys from the
                           existing MineWiki environment into VoteWeb first.`);
}
