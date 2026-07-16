import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { UploadService } from './upload.service';
import type { ConfigService } from '@minewiki/config';
import { BadRequestException } from '@nestjs/common';

function createService(root?: string): UploadService {
  const storageRoot = root ?? mkdtempSync(join(tmpdir(), 'uploads-'));
  const configStub = {
    getOptional(key: string) {
      if (key === 'UPLOAD_STORAGE_ROOT') {
        return storageRoot;
      }
      return undefined;
    }
  } as unknown as ConfigService;
  return new UploadService(configStub);
}

test('stores valid png image after sanitisation', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'uploads-'));
  const service = createService(storageRoot);
  const buffer = await sharp({
    create: {
      width: 400,
      height: 200,
      channels: 3,
      background: '#3366ff'
    }
  })
    .png()
    .toBuffer();

  const stored = await service.storeImage({ buffer, filename: '../banner.png', visibility: 'public' });

  assert.equal(stored.mimeType, 'image/webp');
  assert.ok(stored.filename.endsWith('.webp'));
  assert.equal(stored.publicPath.startsWith('upload://'), true);
  const fileStat = statSync(stored.storagePath);
  assert.ok(fileStat.isFile());
  assert.ok(stored.width <= 400 && stored.height <= 200);
  await service.deleteObject(stored.storagePath);
  assert.equal(existsSync(stored.storagePath), false);
  await assert.rejects(() => service.deleteObject(join(storageRoot, '..', 'outside.webp')), /outside the configured upload root/);
  rmSync(storageRoot, { recursive: true, force: true });
});

test('uses configured public base URL for locally stored images', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'uploads-'));
  const configStub = {
    getOptional(key: string) {
      if (key === 'UPLOAD_STORAGE_ROOT') {
        return storageRoot;
      }
      if (key === 'STORAGE_PUBLIC_BASE_URL') {
        return 'https://minewiki.example/uploads/';
      }
      return undefined;
    }
  } as unknown as ConfigService;
  const service = new UploadService(configStub);
  const buffer = await sharp({
    create: {
      width: 4,
      height: 4,
      channels: 3,
      background: '#13ec80'
    }
  })
    .png()
    .toBuffer();

  const stored = await service.storeImage({ buffer, filename: 'banner.png', visibility: 'public' });

  assert.match(stored.publicPath, /^https:\/\/minewiki\.example\/uploads\/.+\.webp$/);
  rmSync(storageRoot, { recursive: true, force: true });
});

test('private local image exposes only the protected API raw route', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'uploads-'));
  const configStub = {
    getOptional(key: string) {
      if (key === 'UPLOAD_STORAGE_ROOT') return storageRoot;
      if (key === 'STORAGE_PUBLIC_BASE_URL') return 'https://cdn.example.test/uploads';
      return undefined;
    }
  } as unknown as ConfigService;
  const service = new UploadService(configStub);
  const buffer = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#123456' }
  }).png().toBuffer();

  const stored = await service.storeImage({ buffer, filename: 'private.png', visibility: 'private' });
  assert.match(stored.publicPath, /^\/v1\/files\/public\/.+\.webp\/raw$/u);
  assert.equal(stored.publicPath.includes('cdn.example.test'), false);
  rmSync(storageRoot, { recursive: true, force: true });
});

test('S3 uploads separate public and private object namespaces', async () => {
  const configStub = {
    getOptional(key: string) {
      const values: Record<string, string> = {
        STORAGE_BUCKET: 'minewiki-files',
        STORAGE_PUBLIC_BASE_URL: 'https://cdn.example.test',
        STORAGE_REGION: 'ap-northeast-2',
        STORAGE_ACCESS_KEY: 'test-access',
        STORAGE_SECRET_KEY: 'test-secret'
      };
      return values[key];
    }
  } as unknown as ConfigService;
  const service = new UploadService(configStub);
  const putKeys: string[] = [];
  (service as unknown as { s3: { send(command: { input: { Key?: string } }): Promise<object> } }).s3 = {
    async send(command) {
      putKeys.push(command.input.Key ?? '');
      return {};
    }
  };
  const buffer = await sharp({
    create: { width: 4, height: 4, channels: 3, background: '#13ec80' }
  }).png().toBuffer();

  const publicImage = await service.storeImage({ buffer, filename: 'public.png', visibility: 'public' });
  const privateImage = await service.storeImage({ buffer, filename: 'private.png', visibility: 'restricted' });

  assert.match(putKeys[0] ?? '', /^uploads\/public\/.+\.webp$/u);
  assert.match(putKeys[1] ?? '', /^uploads\/private\/.+\.webp$/u);
  assert.match(publicImage.publicPath, /^https:\/\/cdn\.example\.test\/uploads\/public\//u);
  assert.match(privateImage.publicPath, /^\/v1\/files\/public\/.+\.webp\/raw$/u);
  assert.equal(privateImage.publicPath.includes('cdn.example.test'), false);
});

test('rejects oversized files', async () => {
  const service = createService();
  const hugeBuffer = Buffer.alloc(2 * 1024 * 1024 + 1, 0xff);
  await assert.rejects(
    service.storeImage({ buffer: hugeBuffer, filename: 'large.png', visibility: 'public' }),
    (error: unknown) =>
      error instanceof BadRequestException && /용량이 허용 범위를 초과/.test(error.message)
  );
});

test('rejects invalid magic bytes', async () => {
  const service = createService();
  const fake = Buffer.from('not-an-image');
  await assert.rejects(
    service.storeImage({ buffer: fake, filename: 'banner.png', visibility: 'public' }),
    (error: unknown) =>
      error instanceof BadRequestException && /지원되지 않는 이미지 형식/.test(error.message)
  );
});

test('resizes large images down to max dimension', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'uploads-'));
  const service = createService(storageRoot);
  const buffer = await sharp({
    create: {
      width: 4096,
      height: 4096,
      channels: 3,
      background: '#ff00ff'
    }
  })
    .jpeg()
    .toBuffer();

  const stored = await service.storeImage({ buffer, filename: 'huge.jpg', visibility: 'public' });
  assert.ok(stored.width <= 2048);
  assert.ok(stored.height <= 2048);
  rmSync(storageRoot, { recursive: true, force: true });
});
