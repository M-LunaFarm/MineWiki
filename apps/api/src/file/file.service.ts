import { BadRequestException, ConflictException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { promises as fs } from 'node:fs';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import {
  UploadService,
  type ImageVisibility,
  type StoredImage
} from '../upload/upload.service';
import { decodeBase64 } from '../upload/upload.utils';
import { FilePermissionService } from './file-permission.service';
import { WikiEditService } from '../wiki/wiki-edit.service';

export interface FileImageUploadRequest {
  readonly data?: string;
  readonly filename?: string;
  readonly usageContext?: string;
  readonly visibility?: string;
  readonly license?: string;
  readonly sourceUrl?: string;
  readonly sourceText?: string;
  readonly linkedResourceType?: string;
  readonly linkedResourceId?: string;
  readonly replaceFileId?: string;
}

export interface FileImageBufferUploadRequest {
  readonly buffer: Buffer;
  readonly filename?: string;
  readonly usageContext?: string;
  readonly visibility?: string;
  readonly license?: string;
  readonly sourceUrl?: string;
  readonly sourceText?: string;
  readonly linkedResourceType?: string;
  readonly linkedResourceId?: string;
  readonly replaceFileId?: string;
}

export interface FileMetadataResponse {
  readonly id: string;
  readonly ownerAccountId: string | null;
  readonly filename: string;
  readonly storageFilename: string;
  readonly wikiFilename: string | null;
  readonly originalName: string | null;
  readonly mimeType: string;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly hash: string;
  readonly publicPath: string;
  readonly usageContext: string;
  readonly visibility: string;
  readonly license: string | null;
  readonly sourceUrl: string | null;
  readonly sourceText: string | null;
  readonly wikiDocumentPath: string | null;
  readonly linkedResourceType: string | null;
  readonly linkedResourceId: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FileImageUploadResponse extends FileMetadataResponse {
  readonly url: string;
}

export interface WikiFileVersionResponse {
  readonly id: string;
  readonly fileId: string;
  readonly pageId: string;
  readonly pageRevisionId: string;
  readonly versionNo: number;
  readonly isCurrent: boolean;
  readonly mimeType: string;
  readonly size: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly hash: string;
  readonly createdAt: string;
}

export interface RawFileResponse {
  readonly buffer?: Buffer;
  readonly redirectUrl?: string;
  readonly mimeType: string;
  readonly filename: string;
  readonly cacheControl: string;
}

@Injectable()
export class FileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadService,
    private readonly permissions: FilePermissionService,
    @Optional() private readonly events?: BusinessEventService,
    @Optional() private readonly wikiEdits?: WikiEditService
  ) {}

  async createImage(
    accountId: string,
    request: FileImageUploadRequest,
    session?: SessionPayload | null
  ): Promise<FileImageUploadResponse> {
    if (!request.data) {
      throw new BadRequestException('Image data is required.');
    }
    const policy = await this.prepareUploadPolicy(request, session);
    const stored = await this.uploads.storeImage({
      buffer: decodeBase64(request.data),
      filename: request.filename?.trim() || undefined,
      visibility: policy.visibility
    });
    return this.createImageRecord(accountId, request, stored, policy, session ?? null);
  }

  async createImageFromBuffer(
    accountId: string | null,
    request: FileImageBufferUploadRequest
  ): Promise<FileImageUploadResponse> {
    const policy = await this.prepareUploadPolicy(request, null);
    const stored = await this.uploads.storeImage({
      buffer: request.buffer,
      filename: request.filename?.trim() || undefined,
      visibility: policy.visibility
    });
    return this.createImageRecord(accountId, request, stored, policy, null);
  }

  private async prepareUploadPolicy(
    request: FileImageUploadRequest | FileImageBufferUploadRequest,
    session?: SessionPayload | null
  ): Promise<{
    usageContext: string;
    visibility: ImageVisibility;
    license: string | null;
    sourceUrl: string | null;
    sourceText: string | null;
    linkedResource: { type: 'wiki_page' | 'wiki_space'; id: string } | null;
  }> {
    const usageContext = normalizeUsageContext(request.usageContext);
    const visibility = usageContext === 'wiki_editor' ? 'restricted' : normalizeVisibility(request.visibility);
    const linkedResource = normalizeLinkedResource(
      request.linkedResourceType,
      request.linkedResourceId,
      visibility
    );
    const metadata = normalizeWikiFileMetadata(request, usageContext);
    if (usageContext === 'wiki_editor' && !linkedResource) {
      throw new BadRequestException('Wiki file uploads require a linked wiki page or space.');
    }
    if (linkedResource && session) {
      await this.permissions.assertCanLink(linkedResource, session);
    } else if (linkedResource) {
      throw new BadRequestException('Linked file uploads require an authenticated session.');
    }
    return { usageContext, visibility, ...metadata, linkedResource };
  }

  private async createImageRecord(
    accountId: string | null,
    request: FileImageUploadRequest | FileImageBufferUploadRequest,
    stored: StoredImage,
    policy: {
      usageContext: string;
      visibility: ImageVisibility;
      license: string | null;
      sourceUrl: string | null;
      sourceText: string | null;
      linkedResource: { type: 'wiki_page' | 'wiki_space'; id: string } | null;
    },
    session: SessionPayload | null
  ): Promise<FileImageUploadResponse> {
    const { usageContext, visibility, license, sourceUrl, sourceText, linkedResource } = policy;
    let wikiFilename: string | null = null;
    let replacement: Awaited<ReturnType<FileService['resolveReplacementTarget']>> = null;
    try {
      wikiFilename = usageContext === 'wiki_editor'
        ? normalizeWikiFilename(request.filename, stored.filename)
        : null;
      replacement = await this.resolveReplacementTarget(request, policy, session, wikiFilename);
      if (replacement) wikiFilename = replacement.wikiFilename;
    } catch (error) {
      await this.uploads.deleteObject(stored.storagePath).catch(() => undefined);
      throw error;
    }
    let created;
    try {
      created = await this.prisma.uploadedFile.create({
        data: {
          ownerAccountId: accountId,
          filename: stored.filename,
          wikiFilename,
          currentWikiFilename: null,
          originalName: request.filename?.trim() || null,
          mimeType: stored.mimeType,
          sizeBytes: stored.size,
          width: stored.width,
          height: stored.height,
          sha256: stored.hash,
          storagePath: stored.storagePath,
          publicPath: stored.publicPath,
          usageContext,
          visibility,
          license,
          sourceUrl,
          sourceText,
          linkedResourceType: linkedResource?.type ?? null,
          linkedResourceId: linkedResource?.id ?? null,
          status: usageContext === 'wiki_editor' ? 'pending' : 'active'
        }
      });
    } catch (error) {
      await this.uploads.deleteObject(stored.storagePath).catch(() => undefined);
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && wikiFilename) {
        throw new ConflictException('A wiki file with this name already exists.');
      }
      throw error;
    }
    if (usageContext === 'wiki_editor') {
      if (!session || !this.wikiEdits) {
        await this.releaseFailedWikiUpload(created.id);
        await this.uploads.deleteObject(stored.storagePath).catch(() => undefined);
        throw new BadRequestException('Wiki file document service is unavailable.');
      }
      let documentCreated = false;
      try {
        if (replacement) {
          await this.wikiEdits.replaceFileDocumentAfterAuthorizedUpload(session, {
            filename: replacement.wikiFilename,
            expectedFileId: replacement.id,
            uploadedFileId: created.id,
          });
          created = await this.prisma.uploadedFile.findUniqueOrThrow({ where: { id: created.id } });
        } else {
          const document = await this.wikiEdits.createFileDocumentAfterAuthorizedUpload(session, {
            filename: created.wikiFilename!,
            ...(linkedResource!.type === 'wiki_page'
              ? { linkedPageId: linkedResource!.id }
              : { linkedSpaceId: linkedResource!.id })
          });
          documentCreated = true;
          created = await this.prisma.$transaction(async (tx) => {
            await tx.wikiFileVersion.create({
              data: {
                filePageId: BigInt(document.pageId),
                pageRevisionId: BigInt(document.revisionId),
                uploadedFileId: created.id,
                versionNo: 1,
                isCurrent: true,
                createdByAccountId: accountId,
                createdAt: created.createdAt,
              },
            });
            return tx.uploadedFile.update({
              where: { id: created.id },
              data: { status: 'active', currentWikiFilename: created.wikiFilename },
            });
          });
        }
      } catch (error) {
        if (documentCreated) {
          await this.wikiEdits.deleteFileDocumentAfterAuthorizedUpload(session, created.wikiFilename!).catch(() => undefined);
        }
        await this.releaseFailedWikiUpload(created.id);
        await this.uploads.deleteObject(stored.storagePath).catch(() => undefined);
        throw error;
      }
    }
    await this.events?.audit('file.upload', {
      category: 'file',
      actorAccountId: accountId,
      subjectType: 'file',
      subjectId: created.id,
      metadata: {
        filename: created.wikiFilename ?? created.filename,
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

  private async releaseFailedWikiUpload(id: string): Promise<void> {
    await this.prisma.uploadedFile.update({
      where: { id },
      data: { status: 'deleted', wikiFilename: null, currentWikiFilename: null }
    });
  }

  private async resolveReplacementTarget(
    request: FileImageUploadRequest | FileImageBufferUploadRequest,
    policy: { readonly usageContext: string; readonly linkedResource: { type: 'wiki_page' | 'wiki_space'; id: string } | null },
    session: SessionPayload | null,
    requestedWikiFilename: string | null,
  ) {
    const replaceFileId = request.replaceFileId?.trim();
    if (!replaceFileId) return null;
    if (policy.usageContext !== 'wiki_editor' || !session || !requestedWikiFilename) {
      throw new BadRequestException('Only authenticated wiki uploads can replace a file version.');
    }
    const current = await this.prisma.uploadedFile.findUnique({ where: { id: replaceFileId } });
    this.permissions.assertCanDelete(current, session);
    if (
      current.usageContext !== 'wiki_editor'
      || current.status !== 'active'
      || !current.wikiFilename
      || current.currentWikiFilename !== current.wikiFilename
    ) {
      throw new ConflictException('The selected file is not the current wiki file version.');
    }
    if (
      current.linkedResourceType !== policy.linkedResource?.type
      || current.linkedResourceId !== policy.linkedResource.id
    ) {
      throw new BadRequestException('A replacement must keep the original wiki access scope.');
    }
    return current;
  }

  async getFile(id: string, session?: SessionPayload | null): Promise<FileMetadataResponse> {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id } });
    await this.permissions.assertCanRead(file, session);
    return toFileMetadata(file);
  }

  async listWikiFileVersions(
    id: string,
    session?: SessionPayload | null,
  ): Promise<WikiFileVersionResponse[]> {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id } });
    await this.permissions.assertCanRead(file, session);
    const anchor = await this.prisma.wikiFileVersion.findFirst({
      where: { uploadedFileId: file.id },
      select: { filePageId: true },
    });
    if (!anchor) return [];
    const versions = await this.prisma.wikiFileVersion.findMany({
      where: { filePageId: anchor.filePageId },
      orderBy: { versionNo: 'desc' },
      include: { uploadedFile: true },
    });
    return versions.map((version) => ({
      id: version.id.toString(),
      fileId: version.uploadedFileId,
      pageId: version.filePageId.toString(),
      pageRevisionId: version.pageRevisionId.toString(),
      versionNo: version.versionNo,
      isCurrent: version.isCurrent,
      mimeType: version.uploadedFile.mimeType,
      size: version.uploadedFile.sizeBytes,
      width: version.uploadedFile.width,
      height: version.uploadedFile.height,
      hash: version.uploadedFile.sha256,
      createdAt: version.createdAt.toISOString(),
    }));
  }

  async restoreWikiFileVersion(
    id: string,
    versionId: string,
    expectedCurrentVersionNo: number,
    session: SessionPayload,
  ) {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id } });
    await this.permissions.assertCanRead(file, session);
    if (!/^\d+$/u.test(versionId) || !Number.isSafeInteger(expectedCurrentVersionNo) || expectedCurrentVersionNo < 1) {
      throw new BadRequestException('A valid version and current version number are required.');
    }
    if (!this.wikiEdits) throw new ServiceUnavailableException('Wiki file document service is unavailable.');
    const [anchor, target] = await Promise.all([
      this.prisma.wikiFileVersion.findFirst({ where: { uploadedFileId: file.id } }),
      this.prisma.wikiFileVersion.findUnique({ where: { id: BigInt(versionId) } }),
    ]);
    if (!anchor || !target || anchor.filePageId !== target.filePageId) {
      throw new BadRequestException('The selected version does not belong to this file.');
    }
    return this.wikiEdits.restoreFileVersion(session, target.id, expectedCurrentVersionNo);
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
          { visibility: { in: ['public', 'restricted'] } },
          ...(input.session?.permissions?.includes('file.admin')
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
                  { wikiFilename: { contains: search } },
                  { originalName: { contains: search } }
                ]
              }]
            }
          : {})
      },
      orderBy: [{ createdAt: 'desc' }],
      take: limit
    });
    const visible: FileMetadataResponse[] = [];
    for (const file of files) {
      try {
        await this.permissions.assertCanRead(file, input.session);
        visible.push(toFileMetadata(file));
      } catch {
        // Omit files the caller cannot read without revealing their existence.
      }
    }
    return visible;
  }

  async getRawFile(
    id: string,
    session?: SessionPayload | null
  ): Promise<RawFileResponse> {
    const file = await this.prisma.uploadedFile.findUnique({ where: { id } });
    return this.readRawFile(file, session);
  }

  async getRawFileByFilename(filename: string, session?: SessionPayload | null): Promise<RawFileResponse> {
    const normalized = filename.trim();
    if (!normalized || normalized.includes('/') || normalized.includes('\\')) {
      return this.readRawFile(null, session);
    }
    const file = await this.prisma.uploadedFile.findFirst({ where: { filename: normalized } });
    return this.readRawFile(file, session);
  }

  private async readRawFile(
    file: Awaited<ReturnType<PrismaService['uploadedFile']['findUnique']>>,
    session?: SessionPayload | null
  ): Promise<RawFileResponse> {
    await this.permissions.assertCanRead(file, session);
    const cacheControl = file.visibility === 'public' || file.visibility === 'unlisted'
      ? 'public, max-age=31536000, immutable'
      : 'private, no-store';
    if (file.storagePath.startsWith('s3://')) {
      if (file.visibility !== 'public' && file.visibility !== 'unlisted') {
        return {
          buffer: await this.uploads.readPrivateObject(file.storagePath),
          mimeType: file.mimeType,
          filename: file.filename,
          cacheControl
        };
      }
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
    const file = await this.prisma.$transaction(async (tx) => {
      const current = await tx.uploadedFile.findUnique({ where: { id } });
      this.permissions.assertCanDelete(current, session);
      if (current.status === 'active' && current.usageContext === 'wiki_editor') {
        const references = await tx.$queryRaw<Array<{ sourcePageId: bigint }>>`
          SELECT l.source_page_id AS sourcePageId
          FROM page_links l
          JOIN pages p
            ON p.id = l.source_page_id
           AND p.current_revision_id = l.source_revision_id
          JOIN namespaces n
            ON n.id = p.namespace_id
          WHERE l.target_namespace_code = 'file'
            AND l.target_slug = ${current.wikiFilename ?? current.filename}
            AND l.link_type = 'file'
            AND p.status <> 'deleted'
            AND NOT (
              n.code = 'file'
              AND p.title = ${current.wikiFilename ?? current.filename}
            )
          LIMIT 1
        `;
        if (references.length > 0) {
          throw new ConflictException('File is still referenced by a current wiki document.');
        }
      }
      if (current.status === 'active') {
        await tx.uploadedFile.update({ where: { id }, data: { status: 'delete_pending' } });
      }
      return current;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    const isWikiAsset = file.usageContext === 'wiki_editor' && Boolean(file.wikiFilename);
    if (isWikiAsset && file.wikiFilename) {
      if (!this.wikiEdits) {
        throw new ServiceUnavailableException('Wiki file document service is unavailable. Retry the same request.');
      }
      await this.wikiEdits.deleteFileDocumentAfterAuthorizedUpload(session, file.wikiFilename);
    } else {
      try {
        await this.uploads.deleteObject(file.storagePath);
      } catch {
        throw new ServiceUnavailableException('Stored file deletion failed. Retry the same request.');
      }
    }
    const deletedAt = new Date();
    await this.prisma.uploadedFile.update({
      where: { id },
      data: isWikiAsset
        ? { status: 'retained', deletedAt, retainedUntil: retentionDeadline(deletedAt) }
        : { status: 'deleted', wikiFilename: null, currentWikiFilename: null, deletedAt, retainedUntil: null }
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

  async deleteUnreferencedServerBanner(publicPath: string): Promise<boolean> {
    const file = await this.prisma.uploadedFile.findFirst({
      where: {
        publicPath,
        usageContext: 'server_banner',
        status: 'active',
      },
    });
    if (!file) return false;
    const references = await this.prisma.server.count({ where: { bannerUrl: publicPath } });
    if (references > 0) return false;
    const claimed = await this.prisma.uploadedFile.updateMany({
      where: { id: file.id, status: 'active' },
      data: { status: 'delete_pending' },
    });
    if (claimed.count !== 1) return false;
    try {
      await this.uploads.deleteObject(file.storagePath);
    } catch (error) {
      await this.prisma.uploadedFile.updateMany({
        where: { id: file.id, status: 'delete_pending' },
        data: { status: 'active' },
      });
      throw error;
    }
    await this.prisma.uploadedFile.update({
      where: { id: file.id },
      data: {
        status: 'deleted',
        wikiFilename: null,
        currentWikiFilename: null,
        deletedAt: new Date(),
        retainedUntil: null,
      },
    });
    return true;
  }
}

function retentionDeadline(deletedAt: Date): Date {
  return new Date(deletedAt.getTime() + 90 * 24 * 60 * 60 * 1_000);
}

function normalizeUsageContext(value?: string): string {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  return normalized ? normalized.slice(0, 64) : 'general';
}

function normalizeVisibility(value?: string): ImageVisibility {
  const normalized = value?.trim().toLowerCase();
  return normalized && ['public', 'unlisted', 'private', 'restricted'].includes(normalized)
    ? normalized as ImageVisibility
    : 'public';
}

function normalizeLinkedResource(
  typeValue: string | undefined,
  idValue: string | undefined,
  visibility: string
): { type: 'wiki_page' | 'wiki_space'; id: string } | null {
  const type = typeValue?.trim().toLowerCase();
  const id = idValue?.trim();
  if (!type && !id) {
    if (visibility === 'restricted') {
      throw new BadRequestException('Restricted files require a linked wiki page or space.');
    }
    return null;
  }
  if ((type !== 'wiki_page' && type !== 'wiki_space') || !id || !/^\d+$/.test(id)) {
    throw new BadRequestException('Linked resource must be wiki_page or wiki_space with an unsigned id.');
  }
  return { type, id };
}

function toFileMetadata(file: {
  id: string;
  ownerAccountId: string | null;
  filename: string;
  wikiFilename: string | null;
  originalName: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  publicPath: string;
  usageContext: string;
  visibility: string;
  license: string | null;
  sourceUrl: string | null;
  sourceText: string | null;
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
    storageFilename: file.filename,
    wikiFilename: file.wikiFilename,
    originalName: file.originalName,
    mimeType: file.mimeType,
    size: file.sizeBytes,
    width: file.width,
    height: file.height,
    hash: file.sha256,
    publicPath: file.publicPath,
    usageContext: file.usageContext,
    visibility: file.visibility,
    license: file.license,
    sourceUrl: file.sourceUrl,
    sourceText: file.sourceText,
    wikiDocumentPath: file.usageContext === 'wiki_editor'
      ? `/file/${encodeURIComponent(file.wikiFilename ?? file.filename)}`
      : null,
    linkedResourceType: file.linkedResourceType,
    linkedResourceId: file.linkedResourceId,
    status: file.status,
    createdAt: file.createdAt.toISOString(),
    updatedAt: file.updatedAt.toISOString()
  };
}

function normalizeWikiFilename(requestedName: string | undefined, fallback: string): string {
  const requested = requestedName?.normalize('NFC').trim() || fallback;
  const storageExtension = fallback.match(/(\.[A-Za-z0-9]+)$/u)?.[1]?.toLowerCase() ?? '';
  const requestedWithoutExtension = requested.replace(/\.[^.]+$/u, '');
  const normalized = `${requestedWithoutExtension || requested}${storageExtension}`
    .replace(/\s+/gu, '_');
  const hasForbiddenCharacter = Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || /\p{Cf}/u.test(character) || '<>:"|?*\\/[]'.includes(character);
  });
  if (
    normalized.length > 255
    || hasForbiddenCharacter
    || normalized === '.'
    || normalized === '..'
  ) {
    throw new BadRequestException('Wiki filename is invalid.');
  }
  return normalized;
}

const WIKI_FILE_LICENSES = new Set([
  'self-created',
  'cc-by-4.0',
  'cc-by-sa-4.0',
  'cc0-1.0',
  'public-domain',
  'fair-use',
  'permission-granted'
]);

function normalizeWikiFileMetadata(
  request: FileImageUploadRequest | FileImageBufferUploadRequest,
  usageContext: string
): { license: string | null; sourceUrl: string | null; sourceText: string | null } {
  if (usageContext !== 'wiki_editor') {
    return { license: null, sourceUrl: null, sourceText: null };
  }
  const license = request.license?.trim().toLowerCase() ?? '';
  if (!WIKI_FILE_LICENSES.has(license)) {
    throw new BadRequestException('A supported wiki file license is required.');
  }
  const sourceUrl = normalizeSourceUrl(request.sourceUrl);
  if (license !== 'self-created' && !sourceUrl) {
    throw new BadRequestException('A source URL is required for files not created by the uploader.');
  }
  const sourceText = request.sourceText?.trim();
  if (sourceText && sourceText.length > 255) {
    throw new BadRequestException('sourceText is too long.');
  }
  return {
    license,
    sourceUrl,
    sourceText: sourceText || (license === 'self-created' ? '업로더 직접 제작' : null)
  };
}

function normalizeSourceUrl(value?: string): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (normalized.length > 1024) throw new BadRequestException('sourceUrl is too long.');
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new BadRequestException('sourceUrl must be a valid HTTP(S) URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException('sourceUrl must be a valid HTTP(S) URL.');
  }
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}
