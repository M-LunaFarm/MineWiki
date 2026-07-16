import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wikiLinkResolutionContext } from './wiki-link-context';

test('server wiki link contexts remove the isolated server slug and preserve its root', () => {
  assert.deepEqual(wikiLinkResolutionContext('server', 'luna/가이드/설치'), {
    currentDocumentPath: '가이드/설치',
    namespace: 'main',
  });
  assert.deepEqual(wikiLinkResolutionContext('server', 'luna'), {
    currentDocumentPath: '',
    namespace: 'main',
  });
});

test('regular wiki link contexts inherit their namespace', () => {
  assert.deepEqual(wikiLinkResolutionContext('guide', '/설치/리눅스/'), {
    currentDocumentPath: '설치/리눅스',
    namespace: 'guide',
  });
});
