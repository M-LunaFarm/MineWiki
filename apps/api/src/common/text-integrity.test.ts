import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const MOJIBAKE_PATTERN =
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufffd]|\?[가-힣]|[가-힣]\?/u;

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return listTypeScriptFiles(path);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

test('API source does not contain common Korean mojibake sequences', () => {
  const sourceRoot = join(__dirname, '..');
  const corruptedFiles = listTypeScriptFiles(sourceRoot).filter((path) =>
    MOJIBAKE_PATTERN.test(readFileSync(path, 'utf8')),
  );

  assert.deepEqual(corruptedFiles, []);
});
