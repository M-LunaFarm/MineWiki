import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parse as parseDotenv } from 'dotenv';

const script = new URL('./sync-voteweb-oauth.mjs', import.meta.url);
const oauth = {
  DISCORD_CLIENT_ID: 'discord-id',
  DISCORD_CLIENT_SECRET: 'discord-secret',
  NAVER_CLIENT_ID: 'naver-id',
  NAVER_CLIENT_SECRET: 'naver-secret',
};
const mail = {
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_USER: 'mailer@example.test',
  SMTP_PASS: 'mail-secret',
  SMTP_SECURE: 'false',
  SMTP_FROM: 'MineWiki <no-reply@example.test>',
};

test('VoteWeb auth and mail sync bootstraps mail once then stays source-directed', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'minewiki-voteweb-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'voteweb.env');
  const target = path.join(directory, 'minewiki.env');
  await writeFile(source, dotenv(oauth), { mode: 0o600 });
  await writeFile(target, dotenv({ ...oauth, ...mail, UNRELATED_SECRET: 'preserved' }), { mode: 0o600 });

  const dryRun = run(source, target, '--bootstrap-mail-source', '--dry-run');
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.deepEqual(parseDotenv(await readFile(source, 'utf8')), oauth);

  const bootstrap = run(source, target, '--bootstrap-mail-source');
  assert.equal(bootstrap.status, 0, bootstrap.stderr);
  assert.equal(bootstrap.stdout.includes('mail source'), true);
  const sourceValues = parseDotenv(await readFile(source, 'utf8'));
  const targetValues = parseDotenv(await readFile(target, 'utf8'));
  assert.deepEqual(pick(sourceValues, Object.keys(mail)), mail);
  assert.deepEqual(pick(targetValues, [...Object.keys(oauth), ...Object.keys(mail)]), { ...oauth, ...mail });
  assert.equal(targetValues.UNRELATED_SECRET, 'preserved');
  assert.equal((await stat(source)).mode & 0o777, 0o600);
  assert.equal((await stat(target)).mode & 0o777, 0o600);

  await writeFile(target, dotenv({ ...oauth, ...mail, SMTP_HOST: 'tampered.test' }), { mode: 0o600 });
  const sync = run(source, target);
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(parseDotenv(await readFile(target, 'utf8')).SMTP_HOST, mail.SMTP_HOST);
});

function run(source, target, ...args) {
  return spawnSync(process.execPath, [script.pathname, `--source=${source}`, `--target=${target}`, ...args], {
    encoding: 'utf8',
  });
}

function dotenv(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n')}\n`;
}

function pick(values, keys) {
  return Object.fromEntries(keys.map((key) => [key, values[key]]));
}
