/// <reference path="./external.d.ts" />

import { extname } from 'node:path';
import sharp from 'sharp';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const DEFAULT_MAX_DIMENSION = 4096;
const DEFAULT_MAX_INPUT_PIXELS = 4096 * 4096;

const ALLOWED_MIME = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp']
]);

export interface ImageValidationOptions {
  readonly maxBytes?: number;
  readonly maxDimension?: number;
  readonly maxInputPixels?: number;
}

export interface SanitizedImage {
  readonly buffer: Buffer;
  readonly mimeType: string;
  readonly extension: string;
  readonly width: number;
  readonly height: number;
  readonly originalSize: number;
}

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

export async function validateImageUpload(
  buffer: Buffer,
  originalName: string,
  options: ImageValidationOptions = {}
): Promise<SanitizedImage> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const maxInputPixels = options.maxInputPixels ?? DEFAULT_MAX_INPUT_PIXELS;

  if (!buffer || buffer.length === 0) {
    throw new ImageValidationError('업로드된 파일이 비어 있습니다.');
  }

  if (buffer.length > maxBytes) {
    throw new ImageValidationError('이미지 용량이 허용 범위를 초과했습니다.');
  }

  const detected = await detectFileType(buffer);
  if (!detected || !ALLOWED_MIME.has(detected.mime)) {
    throw new ImageValidationError('지원되지 않는 이미지 형식입니다. (png, jpg, webp만 허용)');
  }

  const expectedExtension = ALLOWED_MIME.get(detected.mime)!;
  const providedExtension = extname(originalName).toLowerCase();
  if (providedExtension && providedExtension !== expectedExtension) {
    throw new ImageValidationError('파일 확장자와 실제 이미지 형식이 일치하지 않습니다.');
  }

  const image = sharp(buffer, { failOn: 'none', limitInputPixels: maxInputPixels }).removeAlpha();
  const metadata = await image.metadata().catch(() => {
    throw new ImageValidationError('이미지 해상도가 허용 범위를 초과했습니다.');
  });

  if (!metadata.width || !metadata.height) {
    throw new ImageValidationError('이미지 메타데이터를 확인할 수 없습니다.');
  }
  if (metadata.width * metadata.height > maxInputPixels) {
    throw new ImageValidationError('이미지 해상도가 허용 범위를 초과했습니다.');
  }

  let pipeline = image.rotate().withMetadata({ exif: undefined, icc: undefined });
  if (metadata.width > maxDimension || metadata.height > maxDimension) {
    pipeline = pipeline.resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true
    });
  }

  const sanitized = await pipeline.toFormat('webp', { quality: 90 }).toBuffer();
  const sanitizedMetadata = await sharp(sanitized).metadata();

  return {
    buffer: sanitized,
    mimeType: 'image/webp',
    extension: '.webp',
    width: sanitizedMetadata.width ?? metadata.width,
    height: sanitizedMetadata.height ?? metadata.height,
    originalSize: buffer.length
  };
}

type FileTypeResult = Awaited<ReturnType<typeof import('file-type').fileTypeFromBuffer>>;

let fileTypeLoader: Promise<typeof import('file-type').fileTypeFromBuffer> | null = null;

async function loadFileType(): Promise<typeof import('file-type').fileTypeFromBuffer> {
  if (!fileTypeLoader) {
    fileTypeLoader = import('file-type').then((mod) => {
      if (typeof mod.fileTypeFromBuffer === 'function') {
        return mod.fileTypeFromBuffer;
      }
      // Legacy fallback
      if (typeof (mod as unknown as { fromBuffer?: unknown }).fromBuffer === 'function') {
        return (mod as unknown as { fromBuffer: typeof mod.fileTypeFromBuffer }).fromBuffer;
      }
      throw new Error('file-type module does not export fileTypeFromBuffer');
    });
  }
  return fileTypeLoader;
}

async function detectFileType(buffer: Buffer): Promise<FileTypeResult | undefined> {
  const fileTypeFromBuffer = await loadFileType();
  return fileTypeFromBuffer(buffer);
}
