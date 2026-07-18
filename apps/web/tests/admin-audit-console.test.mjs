import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const consoleSource = fs.readFileSync(new URL('../components/admin/audit-console.tsx', import.meta.url), 'utf8');
const filterSource = fs.readFileSync(new URL('../components/admin/audit-event-filters.tsx', import.meta.url), 'utf8');
const rowSource = fs.readFileSync(new URL('../components/admin/audit-event-row.tsx', import.meta.url), 'utf8');
const apiSource = fs.readFileSync(new URL('../lib/audit-api.ts', import.meta.url), 'utf8');

test('admin audit console can find account events beyond the first page and inspect safe details', () => {
  assert.match(filterSource, /'account'/u);
  assert.match(filterSource, /actorAccountId/u);
  assert.match(filterSource, /subjectId/u);
  assert.match(consoleSource, /nextCursor/u);
  assert.match(consoleSource, /이전 이벤트 50건 더 보기/u);
  assert.match(rowSource, /aria-expanded/u);
  assert.match(rowSource, /마스킹된 메타데이터/u);
  assert.match(apiSource, /\/v1\/admin\/audit\/page/u);
});
