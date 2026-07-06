import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptSecret, encryptSecret, hashSecret, isEncryptedSecret } from '../src/index.js';

test('encryptSecret and decryptSecret round trip secret values', () => {
  const encrypted = encryptSecret('secret-value', 'test-key-material');
  assert.equal(isEncryptedSecret(encrypted), true);
  assert.notEqual(encrypted, 'secret-value');
  assert.equal(decryptSecret(encrypted, 'test-key-material'), 'secret-value');
});

test('decryptSecret returns legacy raw values unchanged', () => {
  assert.equal(decryptSecret('legacy-secret', 'test-key-material'), 'legacy-secret');
});

test('hashSecret returns stable sha256 hex', () => {
  assert.equal(hashSecret('secret-value'), hashSecret('secret-value'));
  assert.match(hashSecret('secret-value'), /^[a-f0-9]{64}$/);
});
