import { serverReviewFeedPageSchema, type ServerReviewFeedPage } from '@minewiki/schemas';

export interface ReviewFeedRequest {
  readonly baseUrl: string;
  readonly serverId: string;
  readonly scope: 'staff' | 'mine';
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly sort?: 'wilson' | 'newest';
  readonly rating?: number;
  readonly tag?: string;
  readonly visibility?: 'all' | 'public' | 'staff';
}

export async function fetchReviewFeedPage(input: ReviewFeedRequest): Promise<ServerReviewFeedPage> {
  const params = new URLSearchParams();
  if (input.cursor) params.set('cursor', input.cursor);
  if (input.limit) params.set('limit', String(input.limit));
  if (input.sort) params.set('sort', input.sort);
  if (input.rating) params.set('rating', String(input.rating));
  if (input.tag?.trim()) params.set('tag', input.tag.trim());
  if (input.visibility) params.set('visibility', input.visibility);
  const response = await fetch(
    `${input.baseUrl}/v1/servers/${encodeURIComponent(input.serverId)}/reviews/${input.scope}/page?${params.toString()}`,
    { credentials: 'include' },
  );
  if (!response.ok) {
    throw new Error(`리뷰 피드를 불러오지 못했습니다. (${response.status})`);
  }
  return serverReviewFeedPageSchema.parse(await response.json());
}
