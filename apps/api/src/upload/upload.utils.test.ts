import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeBase64 } from './upload.utils';

test('decodes canonical raw and data URL base64 payloads', () => {
  assert.equal(decodeBase64('aW1hZ2U=').toString(), 'image');
  assert.equal(decodeBase64('data:video/mp4;base64,dmlkZW8=').toString(), 'video');
});

test('rejects empty, truncated and garbage base64 instead of silently accepting it', () => {
  for (const value of ['', 'abcde', '!!!!', 'data:video/mp4;base64,%%%']) {
    assert.throws(() => decodeBase64(value), /파일 데이터를/u);
  }
});
