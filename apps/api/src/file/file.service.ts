import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import { UploadService, type StoredImage } from '../upload/upload.service';
import { decodeBase64 } from '../upload/upload.utils';
import { FilePermissionService } from './file-permission.service';

export interface FileImageUploadRequest {
  readonly data?: string;
  readonly filename?: string;
  readonly usageContext?: string;
  readonly visibility?: string;
}

export interface FileImageBufferUploadRequest {
  readonly buffer: Buffer;
  readonly filename?: string;
  readonly usageContext?: string;
  readonly visibility?: string;
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
  readonly visibility: string;
  readonly linkedResourceType: string | null;
  readonly linkedResourceId: string | null;
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
    private readonly uploads: UploadService,
    private readonly permissions: FilePermissionService,
    @Optional() private readonly events?: BusinessEventService
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
        usageContext: normalizeUsageContext(request.usageContext),
        visibility: normalizeVisibility(request.visibility)
      }
    });
    await this.events?.audit('file.upload', {
      category: 'file',
      actorAccountId: accountId,
      subjectType: 'file',
      subjectId: created.id,
      metadata: {
        filename: created.filename,
        mimeType: created.mimeType,
        sizeBytes: created.sizeBytes,
        usageContext: created.usageContext,
        visibility: created.visibility
      }
    });
    return {
      ...toFileMetadata(created),
      url: stored.publicPath
    };
  }

  async getFile(id: string, session?: SessionPayload | null): Promise<FileMetadataResponse> {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id } });
    this.permissions.assertCanRead(file, session);
    return toFileMetadata(file);
  }

  async listFiles(input: {
    readonly session?: SessionPayload | null;
    readonly search?: string;
    readonly usageContext?: string;
    readonly limit?: string | number;
  }): Promise<FileMetadataResponse[]> {
    const limit = Math.min(Math.max(Number(input.limit ?? 50) || 50, 1), 100);
    const search = input.search?.trim();
    const usageContext = input.usageContext?.trim() ? normalizeUsageContext(input.usageContext) : null;
    const files = await this.prisma.uploadedFile.findMany({
      where: {
        status: 'active',
        usageContext: usageContext ?? undefined,
        OR: [
          { visibility: { in: ['public', 'unlisted'] } },
          ...(input.session?.isElevated || input.session?.permissions?.includes('file.admin')
            ? [{}]
            : input.session
              ? [{ ownerAccountId: input.session.userId }]
              : [])
        ],
        ...(search
          ? {
              AND: [{
                OR: [
                  { filename: { contains: search } },
                  { originalName: { contains: search } }
                ]
              }]
            }
          : {})
      },
      orderBy: [{ createdAt: 'desc' }],
      take: limit
    });
    return files.map(toFileMetadata);
  }

  async getRawFile(
    id: string,
    session?: SessionPayload | null
  ): Promise<{ buffer?: Buffer; redirectUrl?: string; mimeType: string; filename: string; cacheControl: string }> {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id } });
    this.permissions.assertCanRead(file, session);
    const cacheControl = file.visibility === 'public' || file.visibility === 'unlisted'
      ? 'public, max-age=31536000, immutable'
      : 'private, no-store';
    if (/^https?:\/\//i.test(file.publicPath)) {
      return { redirectUrl: file.publicPath, mimeType: file.mimeType, filename: file.filename, cacheControl };
    }
    if (file.storagePath.startsWith('s3://')) {
      return { redirectUrl: file.publicPath, mimeType: file.mimeType, filename: file.filename, cacheControl };
    }
    return {
      buffer: await fs.readFile(file.storagePath),
      mimeType: file.mimeType,
      filename: file.filename,
      cacheControl
    };
  }

  async deleteFile(id: string, session: SessionPayload): Promise<{ deleted: true }> {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id } });
    this.permissions.assertCanDelete(file, session);
    await this.prisma.uploadedFile.update({
      where: { id },
      data: { status: 'deleted' }
    });
    await this.events?.audit('file.delete', {
      category: 'file',
      actorAccountId: session.userId,
      subjectType: 'file',
      subjectId: id,
      metadata: {
        ownerAccountId: file.ownerAccountId,
        usageContext: file.usageContext,
        visibility: file.visibility
      }
    });
    return { deleted: true };
  }
}

function normalizeUsageContext(value?: string): string {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  return normalized ? normalized.slice(0, 64) : 'general';
}

function normalizeVisibility(value?: string): string {
  const normalized = value?.trim().toLowerCase();
  return normalized && ['public', 'unlisted', 'private', 'restricted'].includes(normalized) ? normalized : 'public';
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
  visibility: string;
  linkedResourceType: string | null;
  linkedResourceId: string | null;
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
    visibility: file.visibility,
    linkedResourceType: file.linkedResourceType,
    linkedResourceId: file.linkedResourceId,
    status: file.status,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString()
  };
}
