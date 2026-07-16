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
    'WikiPage.currentRevisionId belongs to page',
    `
      SELECT p.id
      FROM pages p
      LEFT JOIN page_revisions r ON r.id = p.current_revision_id
      WHERE p.current_revision_id IS NOT NULL
        AND (r.id IS NULL OR r.page_id <> p.id)
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
        AND (p.current_revision_id IS NULL OR r.id IS NULL OR r.page_id <> p.id OR r.visibility <> 'public')
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'public WikiPage has current search document',
    `
      SELECT p.id
      FROM pages p
      JOIN page_revisions r ON r.id = p.current_revision_id AND r.page_id = p.id
      LEFT JOIN wiki_search_documents sd
        ON sd.page_id = p.id
       AND sd.revision_id = p.current_revision_id
      WHERE p.status IN ('normal', 'active', 'published')
        AND r.visibility = 'public'
        AND sd.page_id IS NULL
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
    'ServerWiki layout keys and premium entitlements are valid',
    `
      SELECT sw.id
      FROM server_wikis sw
      WHERE sw.layout_key NOT IN ('docs', 'handbook', 'brand')
         OR (
           sw.layout_key IN ('handbook', 'brand')
           AND NOT EXISTS (
             SELECT 1
             FROM server_wiki_layout_entitlements e
             WHERE e.server_wiki_id = sw.id
               AND e.layout_key = sw.layout_key
               AND e.status = 'active'
               AND e.starts_at <= NOW(3)
               AND (e.expires_at IS NULL OR e.expires_at > NOW(3))
           )
         )
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'ServerWiki layout entitlements point to supported layouts',
    `
      SELECT e.id
      FROM server_wiki_layout_entitlements e
      LEFT JOIN server_wikis sw ON sw.id = e.server_wiki_id
      WHERE sw.id IS NULL
         OR e.layout_key NOT IN ('handbook', 'brand')
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'public Server descriptions are not test placeholders',
    `
      SELECT s.id
      FROM Server s
      WHERE LOWER(TRIM(s.shortDescription)) IN ('test', 'testserver', 'example', 'placeholder', 'todo', 'tbd')
         OR LOWER(TRIM(s.longDescription)) IN ('test', 'testserver', 'example', 'placeholder', 'todo', 'tbd')
         OR LOWER(TRIM(s.name)) LIKE 'test server%'
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
    'wiki discussion polls have valid anchors and lifecycle values',
    `
      SELECT poll.id
      FROM wiki_discussion_polls poll
      LEFT JOIN wiki_discussion_comments comment ON comment.id = poll.comment_id
      LEFT JOIN wiki_discussion_threads thread ON thread.id = comment.thread_id
      WHERE comment.id IS NULL
         OR thread.id IS NULL
         OR poll.status NOT IN ('open', 'closed')
         OR poll.results_visibility NOT IN ('always', 'after_vote', 'closed')
         OR (poll.closed_at IS NOT NULL AND poll.status <> 'closed')
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'wiki discussion polls have two to ten ordered options',
    `
      SELECT poll.id
      FROM wiki_discussion_polls poll
      LEFT JOIN wiki_discussion_poll_options option_row ON option_row.poll_id = poll.id
      GROUP BY poll.id
      HAVING COUNT(option_row.id) < 2
          OR COUNT(option_row.id) > 10
          OR MIN(option_row.position) <> 0
          OR MAX(option_row.position) <> COUNT(option_row.id) - 1
      LIMIT ${args.sampleLimit}
    `,
  );

  await errorIfRows(
    'wiki discussion poll ballots reference their own poll options and profiles',
    `
      SELECT ballot.id
      FROM wiki_discussion_poll_votes ballot
      LEFT JOIN wiki_discussion_polls poll ON poll.id = ballot.poll_id
      LEFT JOIN wiki_discussion_poll_options option_row ON option_row.id = ballot.option_id
      LEFT JOIN users profile ON profile.id = ballot.profile_id
      WHERE poll.id IS NULL
         OR option_row.id IS NULL
         OR option_row.poll_id <> ballot.poll_id
         OR profile.id IS NULL
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
    'session policy snapshots are backed by immutable consent records',
    `
      SELECT session_record.id
      FROM Session session_record
      JOIN Account session_account ON session_account.id = session_record.accountId
      WHERE (
        session_record.terms_policy_version IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM account_consents consent
          JOIN Account member_account ON member_account.id = consent.account_id
          WHERE consent.consent_type = 'terms'
            AND consent.policy_version = session_record.terms_policy_version
            AND (
              member_account.id = session_record.accountId
              OR member_account.id = COALESCE(session_account.canonicalAccountId, session_account.id)
              OR member_account.canonicalAccountId = COALESCE(session_account.canonicalAccountId, session_account.id)
            )
        )
      ) OR (
        session_record.privacy_policy_version IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM account_consents consent
          JOIN Account member_account ON member_account.id = consent.account_id
          WHERE consent.consent_type = 'privacy'
            AND consent.policy_version = session_record.privacy_policy_version
            AND (
              member_account.id = session_record.accountId
              OR member_account.id = COALESCE(session_account.canonicalAccountId, session_account.id)
              OR member_account.canonicalAccountId = COALESCE(session_account.canonicalAccountId, session_account.id)
            )
        )
      )
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
    'ranked ServerStats has a credible calculation timestamp',
    `
      SELECT stats.serverId AS id
      FROM ServerStats stats
      WHERE stats.votesTotal > 0
        AND (
          stats.rank_calculated_at IS NULL
          OR stats.rank_calculated_at > DATE_ADD(NOW(3), INTERVAL 5 MINUTE)
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
    'role assignments belong to canonical Accounts',
    `
      SELECT assignment.id
      FROM account_roles assignment
      JOIN Account account_record ON account_record.id = assignment.account_id
      WHERE account_record.canonicalAccountId IS NOT NULL
        AND assignment.account_id <> account_record.canonicalAccountId
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
  await validatePublicReviewCounts();
  await validateReviewHelpfulCounts();
  await validateReviewReportCounts();
  await validateEncryptedCredentials();
  await validateExpiredReplayGuards();
  await validateRenderCacheGraph();
  await validateRenderCache();
}

async function validatePublicReviewCounts() {
  const mismatches = await prisma.$queryRawUnsafe(
    `
      SELECT s.id
      FROM Server s
      LEFT JOIN (
        SELECT r.serverId, COUNT(*) AS publicCount
        FROM ServerReview r
        WHERE r.visibility = 'public'
        GROUP BY r.serverId
      ) counted ON counted.serverId = s.id
      WHERE s.reviewsCount <> COALESCE(counted.publicCount, 0)
      LIMIT ${args.fixLimit}
    `,
  );
  if (mismatches.length === 0) {
    pass('Server.reviewsCount matches public reviews');
    return;
  }
  if (!args.fix) {
    const sample = mismatches.slice(0, args.sampleLimit).map((row) => stringifyId(row.id)).join(', ');
    error(
      'Server.reviewsCount matches public reviews',
      `${mismatches.length} mismatched counters; sample: ${sample}; rerun with --fix to reconcile`,
    );
    return;
  }
  const fixed = await prisma.$executeRawUnsafe(`
    UPDATE Server s
    LEFT JOIN (
      SELECT r.serverId, COUNT(*) AS publicCount
      FROM ServerReview r
      WHERE r.visibility = 'public'
      GROUP BY r.serverId
    ) counted ON counted.serverId = s.id
    SET s.reviewsCount = COALESCE(counted.publicCount, 0)
    WHERE s.reviewsCount <> COALESCE(counted.publicCount, 0)
  `);
  summary.fixes += fixed;
  pass('Server.reviewsCount matches public reviews', `reconciled ${fixed} server counters`);
}

async function validateReviewHelpfulCounts() {
  const mismatches = await prisma.$queryRawUnsafe(`
    SELECT r.id
    FROM ServerReview r
    LEFT JOIN (
      SELECT hv.reviewId, COUNT(*) AS helpfulCount
      FROM ReviewHelpfulVote hv
      WHERE hv.isHelpful = TRUE
      GROUP BY hv.reviewId
    ) counted ON counted.reviewId = r.id
    WHERE r.helpfulCount <> COALESCE(counted.helpfulCount, 0)
    LIMIT ${args.fixLimit}
  `);
  if (mismatches.length === 0) {
    pass('ServerReview.helpfulCount matches active helpful votes');
    return;
  }
  if (!args.fix) {
    const sample = mismatches.slice(0, args.sampleLimit).map((row) => stringifyId(row.id)).join(', ');
    error(
      'ServerReview.helpfulCount matches active helpful votes',
      `${mismatches.length} mismatched counters; sample: ${sample}; rerun with --fix to reconcile`,
    );
    return;
  }
  const fixed = await prisma.$executeRawUnsafe(`
    UPDATE ServerReview r
    LEFT JOIN (
      SELECT hv.reviewId, COUNT(*) AS helpfulCount
      FROM ReviewHelpfulVote hv
      WHERE hv.isHelpful = TRUE
      GROUP BY hv.reviewId
    ) counted ON counted.reviewId = r.id
    SET r.helpfulCount = COALESCE(counted.helpfulCount, 0)
    WHERE r.helpfulCount <> COALESCE(counted.helpfulCount, 0)
  `);
  summary.fixes += fixed;
  pass('ServerReview.helpfulCount matches active helpful votes', `reconciled ${fixed} review counters`);
}

async function validateReviewReportCounts() {
  const mismatches = await prisma.$queryRawUnsafe(`
    SELECT r.id
    FROM ServerReview r
    LEFT JOIN (
      SELECT rr.reviewId, COUNT(*) AS reportCount
      FROM ReviewReport rr
      GROUP BY rr.reviewId
    ) counted ON counted.reviewId = r.id
    WHERE r.reports <> COALESCE(counted.reportCount, 0)
    LIMIT ${args.fixLimit}
  `);
  if (mismatches.length === 0) {
    pass('ServerReview.reports matches report records');
    return;
  }
  if (!args.fix) {
    const sample = mismatches.slice(0, args.sampleLimit).map((row) => stringifyId(row.id)).join(', ');
    error(
      'ServerReview.reports matches report records',
      `${mismatches.length} mismatched counters; sample: ${sample}; rerun with --fix to reconcile`,
    );
    return;
  }
  const fixed = await prisma.$executeRawUnsafe(`
    UPDATE ServerReview r
    LEFT JOIN (
      SELECT rr.reviewId, COUNT(*) AS reportCount
      FROM ReviewReport rr
      GROUP BY rr.reviewId
    ) counted ON counted.reviewId = r.id
    SET r.reports = COALESCE(counted.reportCount, 0)
    WHERE r.reports <> COALESCE(counted.reportCount, 0)
  `);
  summary.fixes += fixed;
  pass('ServerReview.reports matches report records', `reconciled ${fixed} review counters`);
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

}

async function validateEncryptedCredentials() {
  const [oauthCredentials, votifierTargets, pluginServers, legacyPluginServers] =
    await Promise.all([
      prisma.oAuthCredential.findMany({
        select: { id: true, accessToken: true, refreshToken: true },
        take: args.fixLimit,
      }),
      prisma.votifierTarget.findMany({
        where: { protocol: 'v2', token: { not: null } },
        select: { id: true, token: true },
        take: args.fixLimit,
      }),
      prisma.pluginServer.findMany({
        select: { id: true, serverSecret: true },
        take: args.fixLimit,
      }),
      prisma.lunaGuildServer.findMany({
        select: { id: true, serverSecret: true },
        take: args.fixLimit,
      }),
    ]);

  const plaintext = [
    ...oauthCredentials.flatMap((credential) => [
      ...(!isEncrypted(credential.accessToken)
        ? [{ kind: 'oauth_access', id: credential.id, value: credential.accessToken }]
        : []),
      ...(credential.refreshToken && !isEncrypted(credential.refreshToken)
        ? [{ kind: 'oauth_refresh', id: credential.id, value: credential.refreshToken }]
        : []),
    ]),
    ...votifierTargets.flatMap((target) =>
      target.token && !isEncrypted(target.token)
        ? [{ kind: 'votifier', id: target.id, value: target.token }]
        : [],
    ),
    ...pluginServers.flatMap((server) =>
      !isEncrypted(server.serverSecret)
        ? [{ kind: 'plugin', id: server.id, value: server.serverSecret }]
        : [],
    ),
    ...legacyPluginServers.flatMap((server) =>
      !isEncrypted(server.serverSecret)
        ? [{ kind: 'legacy_plugin', id: server.id, value: server.serverSecret }]
        : [],
    ),
  ];

  if (plaintext.length === 0) {
    pass('stored credentials encrypted');
    return;
  }
  if (!args.fix) {
    error(
      'stored credentials encrypted',
      `${plaintext.length} plaintext credential fields; rerun with --fix to encrypt`,
    );
    return;
  }

  const security = await loadSecurity();
  const encryptionKey = process.env.APP_ENCRYPTION_KEY?.trim();
  if (!security || !encryptionKey) {
    error(
      'stored credentials encrypted',
      'APP_ENCRYPTION_KEY and the built @minewiki/security package are required for --fix',
    );
    return;
  }

  for (const item of plaintext) {
    const encrypted = security.encryptSecret(item.value, encryptionKey);
    if (item.kind === 'oauth_access') {
      await prisma.oAuthCredential.update({ where: { id: item.id }, data: { accessToken: encrypted } });
    } else if (item.kind === 'oauth_refresh') {
      await prisma.oAuthCredential.update({ where: { id: item.id }, data: { refreshToken: encrypted } });
    } else if (item.kind === 'votifier') {
      await prisma.votifierTarget.update({ where: { id: item.id }, data: { token: encrypted } });
    } else if (item.kind === 'plugin') {
      await prisma.pluginServer.update({ where: { id: item.id }, data: { serverSecret: encrypted } });
    } else {
      await prisma.lunaGuildServer.update({ where: { id: item.id }, data: { serverSecret: encrypted } });
    }
    summary.fixes += 1;
  }
  pass('stored credentials encrypted', `encrypted ${plaintext.length} credential fields`);
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
      JOIN page_revisions r ON r.id = p.current_revision_id AND r.page_id = p.id
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

async function validateRenderCacheGraph() {
  const rows = await prisma.$queryRawUnsafe(
    `
      SELECT c.id
      FROM page_render_cache c
      LEFT JOIN pages p ON p.id = c.page_id
      LEFT JOIN page_revisions r ON r.id = c.revision_id
      WHERE p.id IS NULL
         OR r.id IS NULL
         OR r.page_id <> c.page_id
      ORDER BY c.id
      LIMIT ${args.fix ? args.fixLimit : args.sampleLimit}
    `,
  );
  if (rows.length === 0) {
    pass('WikiPage render cache graph', 'every cache belongs to its page revision');
    return;
  }
  if (!args.fix) {
    warn('WikiPage render cache graph', `${rows.length} sampled orphaned or cross-page cache rows; rerun with --fix to delete derived rows`);
    return;
  }
  const ids = rows.map((row) => row.id);
  const deleted = await prisma.wikiPageRenderCache.deleteMany({ where: { id: { in: ids } } });
  summary.fixes += deleted.count;
  pass('WikiPage render cache graph', `deleted ${deleted.count} invalid derived cache rows`);
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

async function loadSecurity() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const modulePath = path.join(scriptDir, '..', 'packages', 'security', 'dist', 'index.js');
  try {
    const imported = await import(pathToFileUrl(modulePath));
    const security = imported.default ?? imported;
    return typeof security.encryptSecret === 'function' ? security : null;
  } catch {
    return null;
  }
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith('enc:v1:');
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
  - reconcile Server.reviewsCount from public reviews
  - reconcile ServerReview.reports from report records
  - encrypt legacy OAuth, Votifier, and plugin credentials
  - delete expired PluginSyncReplayGuard rows
  - disable active plugin credentials whose canonical server no longer exists
  - delete orphaned or cross-page wiki render cache rows
  - rebuild missing render cache for current public wiki revisions`);
}
