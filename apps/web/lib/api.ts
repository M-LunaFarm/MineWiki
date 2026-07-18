import { createApiClient } from '@minewiki/clients';
import {
  reviewTagSchema,
  serverDetailSchema,
  serverUpdateSchema,
  serverStatsSchema,
  serverRankingResponseSchema,
  serverReviewSchema,
  serverReviewPageSchema,
  serverReferralSchema,
  type ServerDetail,
  type ServerReview,
  type ServerReviewPage,
  type ServerStats,
  type ServerRankingResponse,
  type ServerUpdate,
  type ServerSummary,
  type ServerReferral
} from '@minewiki/schemas';
import { normalizeApiBaseUrl } from './runtime-config';

const REVIEW_TAG_SET = new Set(reviewTagSchema.options);

function apiBaseUrl(): string {
  return normalizeApiBaseUrl();
}

function isReviewTag(value?: string | null): value is ServerReview['tags'][number] {
  if (!value) {
    return false;
  }
  return REVIEW_TAG_SET.has(value as ServerReview['tags'][number]);
}

interface ServerSummaryOptions {
  readonly edition?: 'java' | 'bedrock';
  readonly tag?: string;
  readonly search?: string;
  readonly sort?:
    | 'votes24h_desc'
    | 'votesMonthly_desc'
    | 'playersOnline_desc'
    | 'reviews_desc'
    | 'name_asc';
}

export interface ServerRankingOptions {
  readonly edition?: 'java' | 'bedrock';
  readonly grade?: 'Verified' | 'Unverified';
  readonly online?: boolean;
  readonly tag?: string;
  readonly search?: string;
  readonly sort?:
    | 'votes24h_desc'
    | 'votesMonthly_desc'
    | 'playersOnline_desc'
    | 'reviews_desc'
    | 'latest'
    | 'name_asc';
  readonly page?: number;
  readonly pageSize?: number;
  readonly rankEpoch?: string;
}

export class RankingEpochConflictError extends Error {
  constructor() {
    super('The ranking snapshot changed.');
    this.name = 'RankingEpochConflictError';
  }
}

interface ServerReviewOptions {
  readonly limit?: number;
  readonly sort?: 'wilson' | 'newest';
  readonly rating?: number;
  readonly tag?: string;
  readonly cursor?: string;
  readonly cookie?: string;
}

export async function fetchServerSummaries(
  options: ServerSummaryOptions = {}
): Promise<ServerSummary[]> {
  const api = createApiClient(apiBaseUrl());
  return api.listServers(options);
}

export async function fetchServerRankings(
  options: ServerRankingOptions = {}
): Promise<ServerRankingResponse> {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== '') {
      searchParams.set(key, String(value));
    }
  }
  const response = await fetch(
    `${apiBaseUrl()}/v1/servers/rankings?${searchParams.toString()}`,
    { cache: 'no-store' }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 409) {
      throw new RankingEpochConflictError();
    }
    throw new Error(body?.message ?? 'Failed to load server rankings.');
  }
  return serverRankingResponseSchema.parse(await response.json());
}

export async function fetchServerDetail(id: string): Promise<ServerDetail | null> {
  const response = await fetch(`${apiBaseUrl()}/v1/servers/${id}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? `Failed to load server detail (${id}).`);
  }
  const payload = await response.json();
  return serverDetailSchema.parse(payload);
}

export async function fetchServerStats(id: string): Promise<ServerStats | null> {
  const response = await fetch(`${apiBaseUrl()}/v1/servers/${id}/stats`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? `Failed to load server stats (${id}).`);
  }
  const payload = await response.json();
  return serverStatsSchema.parse(payload);
}

export async function fetchServerReviews(
  id: string,
  options: ServerReviewOptions = {}
): Promise<ServerReview[]> {
  const searchParams = new URLSearchParams();
  if (options.limit && options.limit > 0) {
    searchParams.set('limit', String(options.limit));
  }
  if (options.sort) {
    searchParams.set('sort', options.sort);
  }
  if (options.rating && options.rating >= 1 && options.rating <= 5) {
    searchParams.set('rating', String(options.rating));
  }
  if (isReviewTag(options.tag)) {
    searchParams.set('tag', options.tag);
  }
  const response = await fetch(
    `${apiBaseUrl()}/v1/servers/${id}/reviews?${searchParams.toString()}`
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? `Failed to load server reviews (${id}).`);
  }
  const payload = await response.json();
  return serverReviewSchema.array().parse(payload);
}

export async function fetchServerReviewPage(
  id: string,
  options: ServerReviewOptions = {}
): Promise<ServerReviewPage> {
  const searchParams = new URLSearchParams();
  if (options.limit && options.limit > 0) searchParams.set('limit', String(options.limit));
  if (options.sort) searchParams.set('sort', options.sort);
  if (options.rating && options.rating >= 1 && options.rating <= 5) {
    searchParams.set('rating', String(options.rating));
  }
  if (isReviewTag(options.tag)) searchParams.set('tag', options.tag);
  if (options.cursor) searchParams.set('cursor', options.cursor);
  const response = await fetch(
    `${apiBaseUrl()}/v1/servers/${id}/reviews/page?${searchParams.toString()}`,
    {
      cache: 'no-store',
      credentials: 'include',
      headers: options.cookie ? { cookie: options.cookie } : undefined,
    }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? `Failed to load server review page (${id}).`);
  }
  return serverReviewPageSchema.parse(await response.json());
}

export async function fetchServerReferrals(
  id: string,
  options: { limit?: number; search?: string } = {}
): Promise<ServerReferral[]> {
  const searchParams = new URLSearchParams();
  if (options.limit) {
    searchParams.set('limit', String(options.limit));
  }
  if (options.search) {
    searchParams.set('search', options.search);
  }
  const response = await fetch(
    `${apiBaseUrl()}/v1/servers/${id}/votes/recent?${searchParams.toString()}`,
    { credentials: 'include' }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? `Failed to load server referrals (${id}).`);
  }
  const payload = await response.json();
  return serverReferralSchema.array().parse(payload);
}

export async function fetchServerUpdates(
  id: string,
  options: { limit?: number } = {}
): Promise<ServerUpdate[]> {
  const searchParams = new URLSearchParams();
  if (options.limit && options.limit > 0) {
    searchParams.set('limit', String(options.limit));
  }
  const response = await fetch(
    `${apiBaseUrl()}/v1/servers/${id}/updates?${searchParams.toString()}`
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.message ?? `Failed to load server updates (${id}).`);
  }
  const payload = await response.json();
  return serverUpdateSchema.array().parse(payload);
}
