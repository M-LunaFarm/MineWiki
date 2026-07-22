import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { PrismaService } from '../common/prisma.service';
import type {
  ReleaseCandidateSnapshot,
  ReleaseCandidateAsset,
  ReleaseCandidateIncludeDependency,
  ServerWikiPresentationSnapshot,
  ServerWikiReleaseCandidate,
} from './server-wiki-release-candidate';

type CandidateStore = Prisma.TransactionClient | PrismaService;

export interface PersistedServerWikiReleaseCandidate extends ServerWikiReleaseCandidate {
  readonly id: string;
  readonly status: string;
  readonly sourcePublicationVersion: number;
  readonly requiredApprovals: number;
  readonly submissionReason: string;
  readonly submittedAt: string;
  readonly submittedByProfileId: string | null;
  readonly siteSlug: string;
  readonly contentSlug: string;
  readonly changeRequest: {
    readonly note: string;
    readonly reviewerProfileId: string;
    readonly decidedAt: string;
  } | null;
}

export interface StoredServerWikiReleaseCandidate {
  readonly id: bigint;
  readonly serverWikiId: bigint;
  readonly spaceId: bigint;
  readonly token: string;
  readonly candidate: PersistedServerWikiReleaseCandidate;
  readonly snapshot: ReleaseCandidateSnapshot;
}

const bigintString = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const nullableBigintString = bigintString.nullable();
const dateString = z.string().datetime({ offset: true });
const pageSchema = z.object({
  id: bigintString,
  namespaceId: z.number().int().min(0).max(4_294_967_295),
  spaceId: bigintString,
  localPath: z.string().max(500),
  slug: z.string().max(255),
  title: z.string().max(255),
  displayTitle: z.string().max(255),
  currentRevisionId: bigintString,
  pageType: z.string().max(32),
  protectionLevel: z.string().max(32),
  status: z.string().max(32),
  createdBy: nullableBigintString,
  ownerProfileId: nullableBigintString,
  updatedAt: dateString,
  revisionContent: z.string(),
  publicReadAllowed: z.boolean().default(true),
}).strict();
const linkSchema = z.object({
  sourcePageId: bigintString,
  sourceRevisionId: bigintString,
  targetNamespaceCode: z.string().max(32),
  targetSlug: z.string().max(255),
  linkType: z.string().max(32),
  categoryLabel: z.string().max(255).nullable().default(null),
  categoryBlurred: z.boolean().default(false),
}).strict();
const releaseSnapshotSchema = z.object({
  snapshotVersion: z.number().int().min(1).max(3).default(1),
  presentation: z.object({
    layoutKey: z.string(),
    navigationOrder: z.unknown().nullable(),
    contributionPolicySource: z.string().nullable(),
    editHelpSource: z.string().nullable(),
    topNoticeSource: z.string().nullable(),
    bottomNoticeSource: z.string().nullable(),
    seoTitle: z.string().max(70).nullable().default(null),
    seoDescription: z.string().max(200).nullable().default(null),
    seoIndexingEnabled: z.boolean().default(true),
    brandName: z.string().max(80).nullable().default(null),
    brandLogoUrl: z.string().max(512).nullable().default(null),
    brandFaviconUrl: z.string().max(512).nullable().default(null),
    brandAccentColor: z.string().regex(/^#[0-9a-f]{6}$/u).nullable().default(null),
    requireContributionPolicyAck: z.boolean(),
    contributionPolicyVersion: z.number().int().min(0),
    contentSettingsVersion: z.number().int().min(0),
    navigationVersion: z.number().int().min(0),
  }).strict(),
  pages: z.array(pageSchema),
  links: z.array(linkSchema),
  includeDependencies: z.array(z.object({
    sourcePageId: bigintString,
    sourceRevisionId: bigintString,
    targetNamespaceId: z.number().int().min(0).max(4_294_967_295),
    targetNamespaceCode: z.string().max(32),
    targetSlug: z.string().max(255),
    targetPageId: bigintString,
    targetSpaceId: bigintString,
    targetRevisionId: bigintString,
    targetLocalPath: z.string().max(500),
    targetTitle: z.string().max(255),
    targetProtectionLevel: z.string().max(32),
    targetPageStatus: z.string().max(32),
    targetCreatedBy: nullableBigintString,
    targetOwnerProfileId: nullableBigintString,
    contentRaw: z.string(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    contentSize: z.number().int().min(0),
    publicReadAllowed: z.boolean(),
  }).strict()).default([]),
  assets: z.array(z.object({
    wikiFilename: z.string().max(255),
    uploadedFileId: z.string().uuid(),
    wikiFileVersionId: nullableBigintString,
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    publicPath: z.string().max(1024),
    mimeType: z.string().max(128),
    originalName: z.string().max(255),
    sizeBytes: z.number().int().min(0),
    width: z.number().int().min(0).nullable(),
    height: z.number().int().min(0).nullable(),
    license: z.string().max(64).nullable(),
    sourceUrl: z.string().max(1024).nullable(),
    sourceText: z.string().max(255).nullable(),
    publicReadAllowed: z.boolean(),
  }).strict()).default([]),
}).strict();

export async function submitServerWikiReleaseCandidate(
  store: CandidateStore,
  input: {
    readonly serverWikiId: bigint;
    readonly spaceId: bigint;
    readonly actorProfileId: bigint | null;
    readonly sourcePublicationVersion: number;
    readonly siteSlug: string;
    readonly contentSlug: string;
    readonly requiredApprovals: number;
    readonly submissionReason: string;
    readonly submittedAt: Date;
  },
  snapshot: ReleaseCandidateSnapshot,
): Promise<StoredServerWikiReleaseCandidate> {
  await store.$queryRaw<Array<{ id: bigint }>>`
    SELECT id FROM server_wiki_release_candidates
    WHERE server_wiki_id = ${input.serverWikiId} AND token = ${snapshot.candidate.token}
    FOR UPDATE
  `;
  const existing = await store.serverWikiReleaseCandidate.findUnique({
    where: { serverWikiId_token: { serverWikiId: input.serverWikiId, token: snapshot.candidate.token } },
    select: { requiredApprovals: true, status: true },
  });
  if (existing?.status === 'changes_requested') throw candidateChangesRequested();
  const requiredApprovals = Math.max(input.requiredApprovals, existing?.requiredApprovals ?? 0);
  const record = await store.serverWikiReleaseCandidate.upsert({
    where: { serverWikiId_token: { serverWikiId: input.serverWikiId, token: snapshot.candidate.token } },
    create: {
      serverWikiId: input.serverWikiId,
      spaceId: input.spaceId,
      baselineReleaseId: snapshot.candidate.baselineReleaseId
        ? BigInt(snapshot.candidate.baselineReleaseId)
        : null,
      sourcePublicationVersion: input.sourcePublicationVersion,
      status: 'pending_review',
      token: snapshot.candidate.token,
      siteSlug: input.siteSlug,
      contentSlug: input.contentSlug,
      requiredApprovals,
      submissionReason: input.submissionReason,
      manifestSnapshot: snapshot.candidate as unknown as Prisma.InputJsonValue,
      releaseSnapshot: serializeReleaseSnapshot(snapshot),
      snapshotVersion: snapshot.snapshotVersion,
      createdBy: input.actorProfileId,
      submittedAt: input.submittedAt,
    },
    update: {
      sourcePublicationVersion: input.sourcePublicationVersion,
      status: 'pending_review',
      requiredApprovals,
      submissionReason: input.submissionReason,
      createdBy: input.actorProfileId,
      submittedAt: input.submittedAt,
    },
    select: candidateRecordSelection,
  });
  return restoreStoredCandidate(record, input.serverWikiId, input.spaceId);
}

export async function loadStoredServerWikiReleaseCandidate(
  store: CandidateStore,
  input: {
    readonly id: bigint;
    readonly serverWikiId: bigint;
    readonly spaceId: bigint;
    readonly token: string;
    readonly lock: boolean;
  },
): Promise<StoredServerWikiReleaseCandidate> {
  if (input.lock) {
    await store.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM server_wiki_release_candidates
      WHERE id = ${input.id} AND server_wiki_id = ${input.serverWikiId} AND space_id = ${input.spaceId}
      FOR UPDATE
    `;
  }
  const record = await store.serverWikiReleaseCandidate.findFirst({
    where: {
      id: input.id,
      serverWikiId: input.serverWikiId,
      spaceId: input.spaceId,
      token: input.token,
    },
    select: candidateRecordSelection,
  });
  if (!record) throw candidateUnavailable();
  return restoreStoredCandidate(record, input.serverWikiId, input.spaceId);
}

export async function loadLatestSubmittedServerWikiReleaseCandidate(
  store: CandidateStore,
  input: { readonly serverWikiId: bigint; readonly spaceId: bigint },
): Promise<StoredServerWikiReleaseCandidate | null> {
  const record = await store.serverWikiReleaseCandidate.findFirst({
    where: {
      serverWikiId: input.serverWikiId,
      spaceId: input.spaceId,
      status: { in: ['pending_review', 'changes_requested'] },
    },
    orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    select: candidateRecordSelection,
  });
  return record ? restoreStoredCandidate(record, input.serverWikiId, input.spaceId) : null;
}

const candidateRecordSelection = {
  id: true,
  serverWikiId: true,
  spaceId: true,
  token: true,
  status: true,
  sourcePublicationVersion: true,
  requiredApprovals: true,
  submissionReason: true,
  submittedAt: true,
  createdBy: true,
  siteSlug: true,
  contentSlug: true,
  manifestSnapshot: true,
  releaseSnapshot: true,
  snapshotVersion: true,
  changeRequest: {
    select: { note: true, reviewerProfileId: true, decidedAt: true },
  },
} as const;

function serializeReleaseSnapshot(snapshot: ReleaseCandidateSnapshot): Prisma.InputJsonValue {
  return {
    snapshotVersion: snapshot.snapshotVersion,
    presentation: snapshot.presentation as unknown as Prisma.InputJsonValue,
    pages: snapshot.pages.map((page) => ({
      id: page.id.toString(),
      namespaceId: page.namespaceId,
      spaceId: page.spaceId.toString(),
      localPath: page.localPath,
      slug: page.slug,
      title: page.title,
      displayTitle: page.displayTitle,
      currentRevisionId: page.currentRevisionId.toString(),
      pageType: page.pageType,
      protectionLevel: page.protectionLevel,
      status: page.status,
      createdBy: page.createdBy?.toString() ?? null,
      ownerProfileId: page.ownerProfileId?.toString() ?? null,
      updatedAt: page.updatedAt.toISOString(),
      revisionContent: snapshot.revisionContentByPageId.get(page.id) ?? '',
      publicReadAllowed: page.publicReadAllowed,
    })),
    links: snapshot.links.map((link) => ({
      sourcePageId: link.sourcePageId.toString(),
      sourceRevisionId: link.sourceRevisionId.toString(),
      targetNamespaceCode: link.targetNamespaceCode,
      targetSlug: link.targetSlug,
      linkType: link.linkType,
      categoryLabel: link.categoryLabel,
      categoryBlurred: link.categoryBlurred,
    })),
    includeDependencies: snapshot.includeDependencies.map(serializeIncludeDependency),
    assets: snapshot.assets.map(serializeAsset),
  } as Prisma.InputJsonObject;
}

function serializeIncludeDependency(dependency: ReleaseCandidateIncludeDependency): Prisma.InputJsonObject {
  return {
    sourcePageId: dependency.sourcePageId.toString(),
    sourceRevisionId: dependency.sourceRevisionId.toString(),
    targetNamespaceId: dependency.targetNamespaceId,
    targetNamespaceCode: dependency.targetNamespaceCode,
    targetSlug: dependency.targetSlug,
    targetPageId: dependency.targetPageId.toString(),
    targetSpaceId: dependency.targetSpaceId.toString(),
    targetRevisionId: dependency.targetRevisionId.toString(),
    targetLocalPath: dependency.targetLocalPath,
    targetTitle: dependency.targetTitle,
    targetProtectionLevel: dependency.targetProtectionLevel,
    targetPageStatus: dependency.targetPageStatus,
    targetCreatedBy: dependency.targetCreatedBy?.toString() ?? null,
    targetOwnerProfileId: dependency.targetOwnerProfileId?.toString() ?? null,
    contentRaw: dependency.contentRaw,
    contentHash: dependency.contentHash,
    contentSize: dependency.contentSize,
    publicReadAllowed: dependency.publicReadAllowed,
  };
}

function serializeAsset(asset: ReleaseCandidateAsset): Prisma.InputJsonObject {
  return {
    wikiFilename: asset.wikiFilename,
    uploadedFileId: asset.uploadedFileId,
    wikiFileVersionId: asset.wikiFileVersionId?.toString() ?? null,
    sha256: asset.sha256,
    publicPath: asset.publicPath,
    mimeType: asset.mimeType,
    originalName: asset.originalName,
    sizeBytes: asset.sizeBytes,
    width: asset.width,
    height: asset.height,
    license: asset.license,
    sourceUrl: asset.sourceUrl,
    sourceText: asset.sourceText,
    publicReadAllowed: asset.publicReadAllowed,
  };
}

function restoreStoredCandidate(
  record: {
    readonly id: bigint;
    readonly serverWikiId: bigint;
    readonly spaceId: bigint;
    readonly token: string;
    readonly status: string;
    readonly sourcePublicationVersion: number;
    readonly requiredApprovals: number;
    readonly submissionReason: string;
    readonly submittedAt: Date;
    readonly createdBy: bigint | null;
    readonly siteSlug: string;
    readonly contentSlug: string;
    readonly manifestSnapshot: Prisma.JsonValue;
    readonly releaseSnapshot: Prisma.JsonValue;
    readonly snapshotVersion: number;
    readonly changeRequest: {
      readonly note: string;
      readonly reviewerProfileId: bigint;
      readonly decidedAt: Date;
    } | null;
  },
  serverWikiId: bigint,
  spaceId: bigint,
): StoredServerWikiReleaseCandidate {
  if (record.serverWikiId !== serverWikiId || record.spaceId !== spaceId) throw candidateUnavailable();
  const rawRelease = record.releaseSnapshot && typeof record.releaseSnapshot === 'object' && !Array.isArray(record.releaseSnapshot)
    ? record.releaseSnapshot as Prisma.JsonObject
    : null;
  const embeddedSnapshotVersion = typeof rawRelease?.snapshotVersion === 'number' ? rawRelease.snapshotVersion : 1;
  if (record.snapshotVersion !== embeddedSnapshotVersion) throw candidateCorrupt();
  if (embeddedSnapshotVersion === 3) {
    const rawLinks = Array.isArray(rawRelease?.links) ? rawRelease.links : [];
    if (rawLinks.some((link) => !link || typeof link !== 'object' || Array.isArray(link)
      || !Object.prototype.hasOwnProperty.call(link, 'categoryLabel')
      || !Object.prototype.hasOwnProperty.call(link, 'categoryBlurred'))) {
      throw candidateCorrupt();
    }
  }
  const release = releaseSnapshotSchema.safeParse(record.releaseSnapshot);
  if (!release.success) throw candidateCorrupt();
  if (release.data.snapshotVersion === 3 && release.data.links.some((link) => (
    link.linkType !== 'category' && (link.categoryLabel !== null || link.categoryBlurred)
  ))) throw candidateCorrupt();
  const manifest = record.manifestSnapshot as unknown as ServerWikiReleaseCandidate;
  if (!manifest || manifest.token !== record.token || !Array.isArray(manifest.pages)) throw candidateCorrupt();
  const pages = release.data.pages.map((page) => ({
    ...page,
    id: BigInt(page.id),
    spaceId: BigInt(page.spaceId),
    currentRevisionId: BigInt(page.currentRevisionId),
    createdBy: page.createdBy ? BigInt(page.createdBy) : null,
    ownerProfileId: page.ownerProfileId ? BigInt(page.ownerProfileId) : null,
    updatedAt: new Date(page.updatedAt),
  }));
  if (pages.some((page) => page.spaceId !== spaceId)) throw candidateCorrupt();
  const revisionContentByPageId = new Map(pages.map((page) => [page.id, page.revisionContent]));
  const snapshot: ReleaseCandidateSnapshot = {
    snapshotVersion: release.data.snapshotVersion === 3 ? 3 : release.data.snapshotVersion === 2 ? 2 : 1,
    candidate: manifest,
    presentation: release.data.presentation as ServerWikiPresentationSnapshot,
    pages: pages.map((page) => ({
      id: page.id,
      namespaceId: page.namespaceId,
      spaceId: page.spaceId,
      localPath: page.localPath,
      slug: page.slug,
      title: page.title,
      displayTitle: page.displayTitle,
      currentRevisionId: page.currentRevisionId,
      pageType: page.pageType,
      protectionLevel: page.protectionLevel,
      status: page.status,
      createdBy: page.createdBy,
      ownerProfileId: page.ownerProfileId,
      updatedAt: page.updatedAt,
      publicReadAllowed: page.publicReadAllowed,
    })),
    revisionContentByPageId,
    links: release.data.links.map((link) => ({
      sourcePageId: BigInt(link.sourcePageId),
      sourceRevisionId: BigInt(link.sourceRevisionId),
      targetNamespaceCode: link.targetNamespaceCode,
      targetSlug: link.targetSlug,
      linkType: link.linkType,
      categoryLabel: link.categoryLabel,
      categoryBlurred: link.categoryBlurred,
    })),
    includeDependencies: release.data.includeDependencies.map((dependency): ReleaseCandidateIncludeDependency => ({
      sourcePageId: BigInt(dependency.sourcePageId),
      sourceRevisionId: BigInt(dependency.sourceRevisionId),
      targetNamespaceId: dependency.targetNamespaceId!,
      targetNamespaceCode: dependency.targetNamespaceCode!,
      targetSlug: dependency.targetSlug!,
      targetPageId: BigInt(dependency.targetPageId),
      targetSpaceId: BigInt(dependency.targetSpaceId),
      targetRevisionId: BigInt(dependency.targetRevisionId),
      targetLocalPath: dependency.targetLocalPath!,
      targetTitle: dependency.targetTitle!,
      targetProtectionLevel: dependency.targetProtectionLevel!,
      targetPageStatus: dependency.targetPageStatus!,
      targetCreatedBy: dependency.targetCreatedBy ? BigInt(dependency.targetCreatedBy) : null,
      targetOwnerProfileId: dependency.targetOwnerProfileId ? BigInt(dependency.targetOwnerProfileId) : null,
      contentRaw: dependency.contentRaw!,
      contentHash: dependency.contentHash!,
      contentSize: dependency.contentSize!,
      publicReadAllowed: dependency.publicReadAllowed!,
    })),
    assets: release.data.assets.map((asset): ReleaseCandidateAsset => ({
      wikiFilename: asset.wikiFilename!,
      uploadedFileId: asset.uploadedFileId!,
      wikiFileVersionId: asset.wikiFileVersionId ? BigInt(asset.wikiFileVersionId) : null,
      sha256: asset.sha256!,
      publicPath: asset.publicPath!,
      mimeType: asset.mimeType!,
      originalName: asset.originalName!,
      sizeBytes: asset.sizeBytes!,
      width: asset.width ?? null,
      height: asset.height ?? null,
      license: asset.license ?? null,
      sourceUrl: asset.sourceUrl ?? null,
      sourceText: asset.sourceText ?? null,
      publicReadAllowed: asset.publicReadAllowed!,
    })),
  };
  return {
    id: record.id,
    serverWikiId: record.serverWikiId,
    spaceId: record.spaceId,
    token: record.token,
    candidate: {
      ...manifest,
      id: record.id.toString(),
      status: record.status,
      sourcePublicationVersion: record.sourcePublicationVersion,
      requiredApprovals: record.requiredApprovals,
      submissionReason: record.submissionReason,
      submittedAt: record.submittedAt.toISOString(),
      submittedByProfileId: record.createdBy?.toString() ?? null,
      siteSlug: record.siteSlug,
      contentSlug: record.contentSlug,
      changeRequest: record.changeRequest ? {
        note: record.changeRequest.note,
        reviewerProfileId: record.changeRequest.reviewerProfileId.toString(),
        decidedAt: record.changeRequest.decidedAt.toISOString(),
      } : null,
    },
    snapshot,
  };
}

function candidateUnavailable(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'SERVER_WIKI_RELEASE_CANDIDATE_UNAVAILABLE',
    message: 'The selected server wiki release candidate is unavailable.',
  });
}

function candidateChangesRequested(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'SERVER_WIKI_RELEASE_CHANGES_REQUESTED',
    message: 'This release candidate needs content changes before it can be submitted again.',
  });
}

function candidateCorrupt(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'SERVER_WIKI_RELEASE_CANDIDATE_CORRUPT',
    message: 'The stored server wiki release candidate is inconsistent.',
  });
}
