#!/usr/bin/env node

import './load-environment.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    'DATABASE_URL is required. Set it directly or provide it through .env, .env.local, or MINEWIKI_ENV_FILE.',
  );
  process.exit(1);
}

const prisma = new PrismaClient();
const summary = {
  passed: 0,
  warnings: 0,
  errors: 0,
  fixes: 0,
};

console.log(`MineWiki data validation (${args.fix ? 'fix mode' : 'read-only'})`);

try {
  await runValidation();
} catch (error) {
  summary.errors += 1;
  console.error(`error validation aborted: ${formatError(error)}`);
} finally {
  await prisma.$disconnect();
}

console.log(
  `summary checks passed=${summary.passed} warnings=${summary.warnings} errors=${summary.errors} fixes=${summary.fixes}`,
);

if (summary.errors > 0) {
  process.exitCode = 1;
}

async function runValidation() {
  await errorIfRows(
    'WikiPage.currentRevisionId exists',
    `
      SELECT p.id
      FROM pages p
      LEFT JOIN page_revisions r ON r.id = p.current_revision_id
      WHERE p.current_revision_id IS NOT NULL
        AND r.id IS NULL
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'WikiPage.namespaceId exists',
    `
      SELECT p.id
      FROM pages p
      LEFT JOIN namespaces n ON n.id = p.namespace_id
      WHERE n.id IS NULL
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'WikiPage.spaceId exists',
    `
      SELECT p.id
      FROM pages p
      LEFT JOIN wiki_spaces s ON s.id = p.space_id
      WHERE s.id IS NULL
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'public WikiPage has public current revision',
    `
      SELECT p.id
      FROM pages p
      LEFT JOIN page_revisions r ON r.id = p.current_revision_id
      WHERE p.status NOT IN ('hidden', 'deleted')
        AND (p.current_revision_id IS NULL OR r.id IS NULL OR r.visibility <> 'public')
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'Server.wikiSpaceId points to WikiSpace',
    `
      SELECT s.id
      FROM Server s
      LEFT JOIN wiki_spaces ws ON ws.id = s.wikiSpaceId
      WHERE s.wikiSpaceId IS NOT NULL
        AND ws.id IS NULL
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'Server.wikiPageId points to WikiPage',
    `
      SELECT s.id
      FROM Server s
      LEFT JOIN pages p ON p.id = s.wikiPageId
      WHERE s.wikiPageId IS NOT NULL
        AND p.id IS NULL
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'ServerWiki.voteServerId points to Server',
    `
      SELECT sw.id
      FROM server_wikis sw
      LEFT JOIN Server s ON s.id = sw.vote_server_id
      WHERE sw.vote_server_id IS NOT NULL
        AND s.id IS NULL
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'WikiProfile.accountId points to Account',
    `
      SELECT u.id
      FROM users u
      LEFT JOIN Account a ON a.id = u.account_id
      WHERE u.account_id IS NOT NULL
        AND a.id IS NULL
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'UploadedFile storagePath/publicPath present',
    `
      SELECT f.id
      FROM uploaded_files f
      WHERE f.status <> 'deleted'
        AND (
          f.storage_path IS NULL OR TRIM(f.storage_path) = ''
          OR f.public_path IS NULL OR TRIM(f.public_path) = ''
        )
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'sessions use role-based access instead of elevated bypass',
    `
      SELECT s.id
      FROM Session s
      WHERE s.isElevated = TRUE
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'review trust evidence is complete',
    `
      SELECT r.id
      FROM ServerReview r
      WHERE (
        r.evidenceMinecraftUuid IS NOT NULL
        OR r.evidenceVoteId IS NOT NULL
        OR r.evidenceVerifiedAt IS NOT NULL
        OR r.evidencePolicyVersion IS NOT NULL
      )
      AND (
        r.evidenceMinecraftUuid IS NULL
        OR r.evidenceVoteId IS NULL
        OR r.evidenceVerifiedAt IS NULL
        OR r.evidencePolicyVersion IS NULL
      )
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'review trust evidence matches its vote',
    `
      SELECT r.id
      FROM ServerReview r
      LEFT JOIN Vote v ON v.id = r.evidenceVoteId
      WHERE r.evidenceVoteId IS NOT NULL
        AND (
          v.id IS NULL
          OR v.status <> 'valid'
          OR v.serverId <> r.serverId
          OR v.minecraftUuid IS NULL
          OR v.minecraftUuid <> r.evidenceMinecraftUuid
        )
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'vote dispatch attempt matches vote and target server',
    `
      SELECT a.id
      FROM vote_dispatch_attempts a
      LEFT JOIN Vote v ON v.id = a.vote_id
      LEFT JOIN VotifierTarget t ON t.id = a.target_id
      WHERE v.id IS NULL
        OR v.serverId <> a.server_id
        OR (a.target_id IS NOT NULL AND (t.id IS NULL OR t.serverId <> a.server_id))
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'canonical Account points to an existing connected account',
    `
      SELECT a.id
      FROM Account a
      LEFT JOIN Account canonical ON canonical.id = a.canonicalAccountId
      WHERE a.canonicalAccountId IS NOT NULL
        AND canonical.id IS NULL
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'linked Accounts agree on canonical identity',
    `
      SELECT l.id
      FROM AccountLink l
      JOIN Account source ON source.id = l.primaryAccountId
      JOIN Account target ON target.id = l.linkedAccountId
      WHERE (source.canonicalAccountId IS NOT NULL OR target.canonicalAccountId IS NOT NULL)
        AND COALESCE(source.canonicalAccountId, source.id)
          <> COALESCE(target.canonicalAccountId, target.id)
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'canonical Account group has at most one Minecraft identity',
    `
      SELECT COALESCE(a.canonicalAccountId, a.id) AS id
      FROM Account a
      JOIN MinecraftIdentity m ON m.accountId = a.id
      GROUP BY COALESCE(a.canonicalAccountId, a.id)
      HAVING COUNT(*) > 1
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'completed Discord verification has canonical identity evidence',
    `
      SELECT s.id
      FROM DiscordVerificationSession s
      LEFT JOIN Account a ON a.id = s.accountId
      LEFT JOIN MinecraftIdentity m
        ON m.accountId = s.accountId
       AND m.uuid = s.minecraftUuid
      WHERE s.status IN ('linked', 'synced')
        AND (
          s.accountId IS NULL
          OR s.minecraftUuid IS NULL
          OR s.minecraftName IS NULL
          OR a.id IS NULL
          OR m.accountId IS NULL
        )
      LIMIT ${args.sampleLimit}
    `,
  );

  await validatePluginCredentials();
  await validateExpiredReplayGuards();
  await validateRenderCache();
}

async function validatePluginCredentials() {
  const orphaned = await prisma.$queryRawUnsafe(
    `
      SELECT ps.id
      FROM plugin_servers ps
      LEFT JOIN Server s ON s.id = ps.minewiki_server_id
      WHERE ps.enabled = TRUE
        AND ps.minewiki_server_id IS NOT NULL
        AND s.id IS NULL
      LIMIT ${args.fixLimit}
    `,
  );
  if (orphaned.length === 0) {
    pass('active PluginServer points to canonical Server');
  } else if (!args.fix) {
    const sample = orphaned.slice(0, args.sampleLimit).map((row) => stringifyId(row.id)).join(', ');
    error(
      'active PluginServer points to canonical Server',
      `${orphaned.length} active orphan credentials; sample: ${sample}; rerun with --fix to disable`,
    );
  } else {
    const ids = orphaned.map((row) => String(row.id));
    const disabled = await prisma.pluginServer.updateMany({
      where: { id: { in: ids }, enabled: true },
      data: { enabled: false },
    });
    summary.fixes += disabled.count;
    pass(
      'active PluginServer points to canonical Server',
      `disabled ${disabled.count} orphan credentials`,
    );
  }

  await errorIfRows(
    'canonical PluginServer secret encrypted',
    `
      SELECT ps.id
      FROM plugin_servers ps
      WHERE ps.minewiki_server_id IS NOT NULL
        AND ps.server_secret NOT LIKE 'enc:v1:%'
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'Votifier v2 token encrypted',
    `
      SELECT vt.id
      FROM VotifierTarget vt
      WHERE vt.protocol = 'v2'
        AND vt.token IS NOT NULL
        AND vt.token NOT LIKE 'enc:v1:%'
      LIMIT ${args.sampleLimit}
    `,
  );
}

async function validateExpiredReplayGuards() {
  const expired = await prisma.pluginSyncReplayGuard.count({
    where: { expiresAt: { lt: new Date() } },
  });
  if (expired === 0) {
    pass('PluginSyncReplayGuard expired cleanup', 'no expired guards');
    return;
  }
  if (!args.fix) {
    warn('PluginSyncReplayGuard expired cleanup', `${expired} expired guards; rerun with --fix to delete`);
    return;
  }
  const deleted = await prisma.pluginSyncReplayGuard.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  summary.fixes += deleted.count;
  pass('PluginSyncReplayGuard expired cleanup', `deleted ${deleted.count} expired guards`);
}

async function validateRenderCache() {
  const core = await loadWikiCore();
  if (!core) {
    warn('WikiPage render cache', 'wiki-core build output missing; run pnpm --dir packages/wiki-core build before --fix');
    return;
  }

  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT p.id AS pageId, r.id AS revisionId, r.content_raw AS contentRaw
      FROM pages p
      JOIN page_revisions r ON r.id = p.current_revision_id
      LEFT JOIN page_render_cache c
        ON c.revision_id = r.id
       AND c.renderer_version = ?
      WHERE p.status NOT IN ('hidden', 'deleted')
        AND r.visibility = 'public'
        AND c.id IS NULL
      LIMIT ${args.fixLimit}
    `,
    core.WIKI_RENDERER_VERSION,
  );

  if (rows.length === 0) {
    pass('WikiPage render cache', 'current public revisions have render cache');
    return;
  }
  if (!args.fix) {
    warn('WikiPage render cache', `${rows.length} current public revisions missing cache; rerun with --fix to rebuild`);
    return;
  }

  for (const row of rows) {
    const parsed = core.parseMarkup(row.contentRaw);
    const html = core.renderDocument(parsed.ast);
    await prisma.wikiPageRenderCache.upsert({
      where: {
        revisionId_rendererVersion: {
          revisionId: row.revisionId,
          rendererVersion: core.WIKI_RENDERER_VERSION,
        },
      },
      update: {
        html,
        createdAt: new Date(),
      },
      create: {
        pageId: row.pageId,
        revisionId: row.revisionId,
        rendererVersion: core.WIKI_RENDERER_VERSION,
        html,
        createdAt: new Date(),
      },
    });
    summary.fixes += 1;
  }

  pass('WikiPage render cache', `rebuilt ${rows.length} current render cache entries`);
}

async function errorIfRows(name, sql) {
  const rows = await prisma.$queryRawUnsafe(sql);
  if (rows.length === 0) {
    pass(name);
    return;
  }
  const sample = rows.map((row) => stringifyId(row.id)).join(', ');
  error(name, `${rows.length} sampled invalid rows: ${sample}`);
}

function pass(name, detail = '') {
  summary.passed += 1;
  console.log(`ok ${name}${detail ? ` - ${detail}` : ''}`);
}

function warn(name, detail) {
  summary.warnings += 1;
  console.warn(`warn ${name} - ${detail}`);
}

function error(name, detail) {
  summary.errors += 1;
  console.error(`error ${name} - ${detail}`);
}

async function loadWikiCore() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const modulePath = path.join(scriptDir, '..', 'packages', 'wiki-core', 'dist', 'index.js');
  try {
    const imported = await import(pathToFileUrl(modulePath));
    const core = imported.default ?? imported;
    if (
      typeof core.parseMarkup !== 'function' ||
      typeof core.renderDocument !== 'function' ||
      typeof core.WIKI_RENDERER_VERSION !== 'string'
    ) {
      return null;
    }
    return core;
  } catch {
    return null;
  }
}

function pathToFileUrl(filePath) {
  return `file://${filePath.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function stringifyId(value) {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv) {
  const parsed = {
    fix: false,
    help: false,
    sampleLimit: 20,
    fixLimit: 5000,
  };
  for (const arg of argv) {
    if (arg === '--fix') {
      parsed.fix = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg.startsWith('--sample-limit=')) {
      parsed.sampleLimit = parsePositiveInt(arg.slice('--sample-limit='.length), parsed.sampleLimit);
      continue;
    }
    if (arg.startsWith('--fix-limit=')) {
      parsed.fixLimit = parsePositiveInt(arg.slice('--fix-limit='.length), parsed.fixLimit);
    }
  }
  return parsed;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function printHelp() {
  console.log(`Usage: pnpm data:validate [--fix] [--sample-limit=20] [--fix-limit=5000]

Checks migration integrity across wiki, server, reviews, votes, account identity,
Discord verification, file, and plugin-sync tables.
By default this command never mutates data.

--fix performs safe repairs:
  - delete expired PluginSyncReplayGuard rows
  - disable active plugin credentials whose canonical server no longer exists
  - rebuild missing render cache for current public wiki revisions`);
}
