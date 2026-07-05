import ky, { HTTPError, KyInstance } from 'ky';
import {
  createReviewSchema,
  serverDetailSchema,
  serverReviewSchema,
  serverStatsSchema,
  serverSummarySchema,
  minecraftIdentitySchema,
  minecraftVerificationRequestSchema,
  minecraftAuthorizationStartRequestSchema,
  minecraftAuthorizationStartResponseSchema,
  type CreateReviewPayload,
  type MinecraftIdentity,
  type MinecraftVerificationRequest,
  type MinecraftAuthorizationStartRequest,
  type MinecraftAuthorizationStartResponse,
  type ServerDetail,
  type ServerReview,
  type ServerStats,
  type ServerSummary,
  reviewGateStatusSchema,
  type ReviewGateStatus
} from '@minewiki/schemas';

export class ApiClient {
  private readonly http: KyInstance;

  constructor(baseUrl: string, options?: { token?: string }) {
    this.http = ky.create({
      prefixUrl: baseUrl,
      headers: options?.token ? { Authorization: `Bearer ${options.token}` } : undefined,
      credentials: 'include'
    });
  }

  private static async unwrapResponse<T>(
    request: Promise<Response>,
    parser: (data: unknown) => T
  ): Promise<T> {
    try {
      const response = await request;
      const data = await response.json();
      return parser(data);
    } catch (error) {
      if (error instanceof HTTPError) {
        const body = await error.response.text();
        throw new Error(`API error (${error.response.status}): ${body}`);
      }
      throw error;
    }
  }

  async listServers(options?: {
    edition?: 'java' | 'bedrock';
    tag?: string;
    search?: string;
    sort?: 'votes24h_desc' | 'votesMonthly_desc' | 'reviews_desc' | 'name_asc';
  }): Promise<ServerSummary[]> {
    const searchParams = new URLSearchParams();
    if (options?.edition) {
      searchParams.set('edition', options.edition);
    }
    if (options?.tag) {
      searchParams.set('tag', options.tag);
    }
    if (options?.search) {
      searchParams.set('search', options.search);
    }
    if (options?.sort) {
      searchParams.set('sort', options.sort);
    }
    return ApiClient.unwrapResponse(
      this.http.get('v1/servers', {
        searchParams: searchParams.size > 0 ? searchParams : undefined
      }),
      (data) => serverSummarySchema.array().parse(data)
    );
  }

  async getServer(id: string): Promise<ServerDetail> {
    return ApiClient.unwrapResponse(
      this.http.get(`v1/servers/${id}`),
      (data) => serverDetailSchema.parse(data)
    );
  }

  async getServerStats(id: string): Promise<ServerStats> {
    return ApiClient.unwrapResponse(
      this.http.get(`v1/servers/${id}/stats`),
      (data) => serverStatsSchema.parse(data)
    );
  }

  async listServerReviews(
    id: string,
    options?: {
      limit?: number;
      sort?: 'wilson' | 'newest';
      rating?: number;
      tag?: string;
    }
  ): Promise<ServerReview[]> {
    const searchParams = new URLSearchParams();
    if (options?.limit && options.limit > 0) {
      searchParams.set('limit', String(options.limit));
    }
    if (options?.sort) {
      searchParams.set('sort', options.sort);
    }
    if (options?.rating && options.rating >= 1 && options.rating <= 5) {
      searchParams.set('rating', String(options.rating));
    }
    if (options?.tag) {
      searchParams.set('tag', options.tag);
    }
    return ApiClient.unwrapResponse(
      this.http.get(`v1/servers/${id}/reviews`, {
        searchParams: searchParams.size > 0 ? searchParams : undefined
      }),
      (data) => serverReviewSchema.array().parse(data)
    );
  }

  async createServerReview(
    id: string,
    payload: CreateReviewPayload
  ): Promise<ServerReview> {
    const parsed = createReviewSchema.parse(payload);
    return ApiClient.unwrapResponse(
      this.http.post(`v1/servers/${id}/reviews`, { json: parsed }),
      (data) => serverReviewSchema.parse(data)
    );
  }

  async getReviewGateStatus(id: string): Promise<ReviewGateStatus> {
    return ApiClient.unwrapResponse(
      this.http.get(`v1/servers/${id}/reviews/gate`),
      (data) => reviewGateStatusSchema.parse(data)
    );
  }

  async markReviewHelpful(
    serverId: string,
    reviewId: string,
    isHelpful = true
  ): Promise<ServerReview> {
    return ApiClient.unwrapResponse(
      this.http.post(`v1/servers/${serverId}/reviews/${reviewId}/helpful`, {
        json: { isHelpful }
      }),
      (data) => serverReviewSchema.parse(data)
    );
  }

  async verifyMinecraftOwnership(
    payload: MinecraftVerificationRequest
  ): Promise<MinecraftIdentity> {
    const parsed = minecraftVerificationRequestSchema.parse(payload);
    return ApiClient.unwrapResponse(
      this.http.post('v1/minecraft/verify', { json: parsed }),
      (data) => minecraftIdentitySchema.parse(data)
    );
  }

  async getMinecraftIdentity(userId: string): Promise<MinecraftIdentity> {
    return ApiClient.unwrapResponse(
      this.http.get(`v1/minecraft/identity/${userId}`),
      (data) => minecraftIdentitySchema.parse(data)
    );
  }

  async startMinecraftAuthorization(
    payload: MinecraftAuthorizationStartRequest
  ): Promise<MinecraftAuthorizationStartResponse> {
    const parsed = minecraftAuthorizationStartRequestSchema.parse(payload);
    return ApiClient.unwrapResponse(
      this.http.post('v1/minecraft/oauth/start', { json: parsed }),
      (data) => minecraftAuthorizationStartResponseSchema.parse(data)
    );
  }
}

export function createApiClient(baseUrl: string, token?: string): ApiClient {
  return new ApiClient(baseUrl, { token });
}
