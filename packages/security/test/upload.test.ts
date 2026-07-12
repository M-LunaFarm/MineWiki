import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { ImageValidationError, validateImageUpload } from '../src/upload';

test('rejects compressed images whose decoded pixel count exceeds policy', async () => {
  const oversized = await sharp({
    create: {
      width: 5000,
      height: 4000,
      channels: 3,
      background: { r: 0, g: 0, b: 0 }
    }
  })
    .png({ compressionLevel: 9 })
    .toBuffer();

  assert.ok(oversized.length < 5 * 1024 * 1024);
  await assert.rejects(
    validateImageUpload(oversized, 'oversized.png'),
    (error: unknown) =>
      error instanceof ImageValidationError && /해상도가 허용 범위/.test(error.message)
  );
});

test('keeps normal resize behavior below the decoded pixel limit', async () => {
  const image = await sharp({
    create: {
      width: 3000,
      height: 2000,
      channels: 3,
      background: { r: 20, g: 120, b: 80 }
    }
  })
    .png()
    .toBuffer();

  const result = await validateImageUpload(image, 'normal.png', { maxDimension: 2048 });
  assert.equal(result.width, 2048);
  assert.ok(result.height <= 2048);
});
