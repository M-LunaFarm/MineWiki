import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { mkdirSync, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  validateImageUpload,
  ImageValidationError,
  type SanitizedImage
} from '@minewiki/security';

const MAX_BYTES = 2 * 1024 * 1024; // 2MB cap
const MAX_DIMENSION = 2048; // px
const UPLOAD_PREFIX = 'uploads';
const PUBLIC_UPLOAD_PREFIX = `${UPLOAD_PREFIX}/public`;
const PRIVATE_UPLOAD_PREFIX = `${UPLOAD_PREFIX}/private`;

type StorageMode = 's3' | 'local' | 'disabled';
export type ImageVisibility = 'public' | 'unlisted' | 'private' | 'restricted';

export interface ImageUploadInput {
  readonly buffer: Buffer;
  readonly filename?: string;
  readonly visibility: ImageVisibility;
}

export interface StoredImage {
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly hash: string;
  readonly storagePath: string;
  readonly publicPath: string;
}

@Injectable()
export class UploadService {
  private readonly storageMode: StorageMode;
  private readonly storageRoot?: string;
  private readonly bucket?: string;
  private readonly publicBaseUrl?: string;
  private readonly s3?: S3Client;

  constructor(private readonly config: ConfigService) {
    const bucket = this.config.getOptional('STORAGE_BUCKET');
    const publicBaseUrl = this.config.getOptional('STORAGE_PUBLIC_BASE_URL');
    const endpoint = this.config.getOptional('STORAGE_ENDPOINT');
    const region = this.config.getOptional('STORAGE_REGION') ?? 'us-east-1';
    const accessKeyId = this.config.getOptional('STORAGE_ACCESS_KEY');
    const secretAccessKey = this.config.getOptional('STORAGE_SECRET_KEY');

    if (bucket && publicBaseUrl) {
      this.storageMode = 's3';
      this.bucket = bucket;
      this.publicBaseUrl = publicBaseUrl.replace(/\/$/, '');
      this.s3 = new S3Client({
        region,
        endpoint: endpoint ?? undefined,
        forcePathStyle: Boolean(endpoint),
        credentials:
          accessKeyId && secretAccessKey
            ? { accessKeyId, secretAccessKey }
            : undefined
      });
      return;
    }

    const configuredRoot = this.config.getOptional('UPLOAD_STORAGE_ROOT');
    if (configuredRoot) {
      const root = resolve(configuredRoot);
      this.storageRoot = root;
      this.publicBaseUrl = publicBaseUrl?.replace(/\/$/, '');
      this.storageMode = 'local';
      if (!existsSync(root)) {
        mkdirSync(root, { recursive: true });
      }
      return;
    }

    this.storageMode = 'disabled';
  }

  async storeImage(input: ImageUploadInput): Promise<StoredImage> {
    if (!input.buffer || input.buffer.length === 0) {
      throw new BadRequestException('이미지 데이터가 비어 있습니다.');
    }
    let sanitized: SanitizedImage;
    try {
      sanitized = await validateImageUpload(input.buffer, input.filename ?? 'upload', {
        maxBytes: MAX_BYTES,
        maxDimension: MAX_DIMENSION
      });
    } catch (error) {
      if (error instanceof ImageValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    if (this.storageMode === 'disabled') {
      throw new BadRequestException('Upload storage is not configured.');
    }

    const filename = `${randomUUID()}${sanitized.extension}`;
    const hash = createHash('sha256').update(sanitized.buffer).digest('hex');
    const publiclyReadable = input.visibility === 'public' || input.visibility === 'unlisted';

    if (this.storageMode === 's3') {
      const key = `${publiclyReadable ? PUBLIC_UPLOAD_PREFIX : PRIVATE_UPLOAD_PREFIX}/${filename}`;
      await this.s3!.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: sanitized.buffer,
          ContentType: sanitized.mimeType
        })
      );
      return {
        filename,
        mimeType: sanitized.mimeType,
        size: sanitized.buffer.length,
        width: sanitized.width,
        height: sanitized.height,
        hash,
        storagePath: `s3://${this.bucket}/${key}`,
        publicPath: publiclyReadable
          ? `${this.publicBaseUrl}/${key}`
          : `/v1/files/public/${filename}/raw`
      };
    }

    const storagePath = join(this.storageRoot!, filename);
    await fs.writeFile(storagePath, sanitized.buffer, { mode: 0o600 });

    return {
      filename,
      mimeType: sanitized.mimeType,
      size: sanitized.buffer.length,
      width: sanitized.width,
      height: sanitized.height,
      hash,
      storagePath,
      publicPath: publiclyReadable
        ? this.publicBaseUrl
          ? `${this.publicBaseUrl}/${filename}`
          : `upload://${filename}`
        : `/v1/files/public/${filename}/raw`
    };
  }

  async readPrivateObject(storagePath: string): Promise<Buffer> {
    if (this.storageMode !== 's3' || !this.s3 || !this.bucket) {
      throw new Error('Private object reads require configured S3 storage.');
    }
    const prefix = `s3://${this.bucket}/`;
    if (!storagePath.startsWith(prefix)) {
      throw new Error('Stored object does not belong to the configured bucket.');
    }
    const key = storagePath.slice(prefix.length);
    const isPrivateKey = key.startsWith(`${PRIVATE_UPLOAD_PREFIX}/`);
    const isLegacyKey = /^uploads\/[^/]+$/u.test(key);
    if (!key || (!isPrivateKey && !isLegacyKey) || key.includes('..')) {
      throw new Error('Stored object key is invalid.');
    }
    const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!response.Body) {
      throw new Error('Stored object body is missing.');
    }
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async deleteObject(storagePath: string): Promise<void> {
    if (this.storageMode === 's3' && this.s3 && this.bucket) {
      const prefix = `s3://${this.bucket}/`;
      if (!storagePath.startsWith(prefix)) {
        throw new Error('Stored object does not belong to the configured bucket.');
      }
      const key = storagePath.slice(prefix.length);
      const currentKey = /^uploads\/(?:public|private)\/[A-Za-z0-9-]+\.(?:png|jpe?g|webp)$/iu.test(key);
      const legacyKey = /^uploads\/[A-Za-z0-9-]+\.(?:png|jpe?g|webp)$/iu.test(key);
      if (!currentKey && !legacyKey) throw new Error('Stored object key is invalid.');
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return;
    }
    if (this.storageMode === 'local' && this.storageRoot) {
      const target = resolve(storagePath);
      const relativePath = relative(this.storageRoot, target);
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new Error('Stored object path is outside the configured upload root.');
      }
      await fs.rm(target, { force: true });
      return;
    }
    throw new Error('Upload storage is not configured.');
  }
}
