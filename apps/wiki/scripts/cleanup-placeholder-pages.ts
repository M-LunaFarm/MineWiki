import { exec, one, pool, query } from '../src/db.js';
import { deletePage } from '../src/wiki/repository.js';

const apply = process.argv.includes('--apply');
const includeServer = process.argv.includes('--include-server');

const contentPlaceholderWhere = `
  n.code <> 'server'
  AND p.status <> 'deleted'
  AND (
    (n.code='main' AND (
      p.title REGEXP '^바닐라 (공개 )?기준 문서 [0-9]+$'
      OR p.title LIKE '%검증 %'
      OR p.title IN ('필터 검토 테스트')
    ))
    OR (n.code='mod' AND (
      p.title REGEXP '^Example Mod [0-9]+$'
      OR p.title REGEXP '^Open Mod [0-9]+$'
    ))
    OR (n.code='guide' AND (
      p.title REGEXP '^베타 가이드 [0-9]+$'
      OR p.title REGEXP '^공개 가이드 [0-9]+$'
    ))
    OR (n.code='data' AND (
      p.title REGEXP '^베타 데이터 [0-9]+$'
      OR p.title REGEXP '^공개 데이터 [0-9]+$'
      OR p.title='인증 서버 목록'
    ))
  )
`;

const serverPlaceholderWhere = `
  n.code='server'
  AND p.status <> 'deleted'
  AND (
    p.title REGEXP '^예시서버[0-9]+$'
    OR p.title REGEXP '^공개예시서버[0-9]+$'
    OR p.title IN ('예시서버/접속','예시서버/규칙','예시서버/공지')
    OR r.content_raw LIKE '%공식 안내를 여기에 작성한다.%'
  )
`;

const placeholderWhere = includeServer ? `((${contentPlaceholderWhere}) OR (${serverPlaceholderWhere}))` : contentPlaceholderWhere;

type PlaceholderPage = {
  id: number;
  namespace_code: string;
  title: string;
};

async function main() {
  const admin = await one<{ id: number }>(`SELECT id FROM users WHERE username='admin' ORDER BY id LIMIT 1`);
  const actorId = admin?.id ?? null;
  const pages = await query<PlaceholderPage>(
    `SELECT p.id, n.code AS namespace_code, p.title
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN page_revisions r ON r.id=p.current_revision_id
     WHERE ${placeholderWhere}
     ORDER BY n.code, p.title`
  );
  const byNamespace = pages.reduce<Record<string, number>>((acc, page) => {
    acc[page.namespace_code] = (acc[page.namespace_code] ?? 0) + 1;
    return acc;
  }, {});
  const deletedSearchRows = await one<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM pages p
     JOIN search_index si ON si.page_id=p.id
     WHERE p.status='deleted'`
  );
  const sample = pages.slice(0, 20).map((page) => `${page.namespace_code}:${page.title}`);

  if (!apply) {
    console.log(JSON.stringify({ mode: 'dry-run', includeServer, count: pages.length, byNamespace, deletedSearchRows: Number(deletedSearchRows?.count ?? 0), sample, apply: includeServer ? 'npm run cleanup:placeholders -- --include-server --apply' : 'npm run cleanup:placeholders -- --apply' }, null, 2));
    return;
  }

  for (const page of pages) {
    await deletePage(Number(page.id), actorId);
  }
  const staleSearch = await exec(
    `DELETE si
     FROM search_index si
     JOIN pages p ON p.id=si.page_id
     WHERE p.status='deleted'`
  );

  const remaining = await one<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN page_revisions r ON r.id=p.current_revision_id
     WHERE ${placeholderWhere}`
  );
  console.log(JSON.stringify({ mode: 'apply', includeServer, deleted: pages.length, byNamespace, purgedSearchRows: staleSearch.affectedRows, remaining: Number(remaining?.count ?? 0) }, null, 2));
}

try {
  await main();
} finally {
  await pool.end();
}
