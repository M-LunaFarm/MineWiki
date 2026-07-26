import assert from 'node:assert/strict';
import test from 'node:test';
import { renameUsernameTargetFields, validateWikiUsername } from './wiki-username.service';

test('username validation accepts an explicit trailing underscore', () => {
  assert.equal(validateWikiUsername('zene_'), 'zene_');
});

test('username validation still rejects route-like separators and reserved names', () => {
  assert.throws(() => validateWikiUsername('_zene'));
  assert.throws(() => validateWikiUsername('zene-'));
  assert.throws(() => validateWikiUsername('admin'));
});

test('username rename retargets pending user-document creates away from the preserved alias tree', () => {
  assert.deepEqual(renameUsernameTargetFields({
    targetTitle: 'oldname/guide/start',
    targetSlug: 'oldname/guide/start',
    targetDisplayTitle: 'oldname/guide/start',
  }, 'oldname', 'newname'), {
    targetTitle: 'newname/guide/start',
    targetSlug: 'newname/guide/start',
    targetDisplayTitle: 'newname/guide/start',
  });
});

test('username rename replaces only an exact root prefix', () => {
  assert.deepEqual(renameUsernameTargetFields({
    targetTitle: 'oldname2/guide',
    targetSlug: 'oldname2/guide',
    targetDisplayTitle: 'Friendly title',
  }, 'oldname', 'newname'), {
    targetTitle: 'oldname2/guide',
    targetSlug: 'oldname2/guide',
    targetDisplayTitle: 'Friendly title',
  });
});
