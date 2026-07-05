import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { PrismaService } from '../common/prisma.service';
import { UploadService, type StoredImage } from '../upload/upload.service';
import { decodeBase64 } from '../upload/upload.utils';

export interface FileImageUploadRequest {
  readonly data?: string;
  readonly filename?: string;
  readonly usageContext?: string;
}

export interface FileImageBufferUploadRequest {
  readonly buffer: Buffer;
  readonly filename?: string;
  readonly usageContext?: string;
}

export interface FileMetadataResponse {
  readonly id: string;
  readonly ownerAccountId: string | null;
  readonly filename: string;
  readonly originalName: string | null;
  readonly mimeType: string;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly hash: string;
  readonly publicPath: string;
  readonly usageContext: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FileImageUploadResponse extends FileMetadataResponse {
  readonly url: string;
}

@Injectable()
export class FileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadService
  ) {}

  async createImage(accountId: string, request: FileImageUploadRequest): Promise<FileImageUploadResponse> {
    if (!request.data) {
      throw new BadRequestException('Image data is required.');
    }
    const stored = await this.uploads.storeImage({
      buffer: decodeBase64(request.data),
      filename: request.filename?.trim() || undefined
    });
    return this.createImageRecord(accountId, request, stored);
  }

  async createImageFromBuffer(
    accountId: string | null,
    request: FileImageBufferUploadRequest
  ): Promise<FileImageUploadResponse> {
    const stored = await this.uploads.storeImage({
      buffer: request.buffer,
      filename: request.filename?.trim() || undefined
    });
    return this.createImageRecord(accountId, request, stored);
  }

  private async createImageRecord(
    accountId: string | null,
    request: FileImageUploadRequest | FileImageBufferUploadRequest,
    stored: StoredImage
  ): Promise<FileImageUploadResponse> {
    const created = await this.prisma.uploadedFile.create({
      data: {
        ownerAccountId: accountId,
        filename: stored.filename,
        originalName: request.filename?.trim() || null,
        mimeType: stored.mimeType,
        sizeBytes: stored.size,
        width: stored.width,
        height: stored.height,
        sha256: stored.hash,
        storagePath: stored.storagePath,
        publicPath: stored.publicPath,
        usageContext: normalizeUsageContext(request.usageContext)
      }
    });
    return {
      ...toFileMetadata(created),
      url: stored.publicPath
    };
  }

  async getFile(id: string): Promise<FileMetadataResponse> {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id } });
    if (!file || file.status === 'deleted') {
      throw new NotFoundException('File not found.');
    }
    return toFileMetadata(file);
  }

  async getRawFile(id: string): Promise<{ buffer?: Buffer; redirectUrl?: string; mimeType: string; filename: string }> {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id } });
    if (!file || file.status === 'deleted') {
      throw new NotFoundException('File not found.');
    }
    if (/^https?:\/\//i.test(file.publicPath)) {
      return { redirectUrl: file.publicPath, mimeType: file.mimeType, filename: file.filename };
    }
    if (file.storagePath.startsWith('s3://')) {
      return { redirectUrl: file.publicPath, mimeType: file.mimeType, filename: file.filename };
    }
    return {
      buffer: await fs.readFile(file.storagePath),
      mimeType: file.mimeType,
      filename: file.filename
    };
  }

  async deleteFile(id: string, accountId: string): Promise<{ deleted: true }> {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id } });
    if (!file || file.status === 'deleted') {
      throw new NotFoundException('File not found.');
    }
    if (file.ownerAccountId && file.ownerAccountId !== accountId) {
      throw new ForbiddenException('File owner is required.');
    }
    await this.prisma.uploadedFile.update({
      where: { id },
      data: { status: 'deleted' }
    });
    return { deleted: true };
  }
}

function normalizeUsageContext(value?: string): string {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  return normalized ? normalized.slice(0, 64) : 'general';
}

function toFileMetadata(file: {
  id: string;
  ownerAccountId: string | null;
  filename: string;
  originalName: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  publicPath: string;
  usageContext: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): FileMetadataResponse {
  return {
    id: file.id,
    ownerAccountId: file.ownerAccountId,
    filename: file.filename,
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.sizeBytes,
    width: file.width,
    height: file.height,
    hash: file.sha256,
    publicPath: file.publicPath,
    usageContext: file.usageContext,
    status: file.status,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString()
  };
}
