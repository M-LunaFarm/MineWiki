import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import {
  WikiEditService,
  type WikiMutationResponse,
  type WikiPageMutationRequest,
  type WikiRevisionResponse,
} from './wiki-edit.service';
import { WikiApiTokenGuard } from './wiki-api-token.guard';
import {
  WikiApiTokenService,
  type AuthenticatedWikiApiToken,
} from './wiki-api-token.service';
import { WikiReadService, type WikiPageResponse } from './wiki-read.service';

export interface WikiApiPageSummary {
  readonly id: string;
  readonly namespace: string;
  readonly spaceId: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly revision: WikiPageResponse['revision'];
}

@Controller('v1/wiki/api')
@UseGuards(WikiApiTokenGuard)
export class WikiApiController {
  constructor(
    private readonly tokens: WikiApiTokenService,
    private readonly wikiRead: WikiReadService,
    private readonly wikiEdit: WikiEditService,
  ) {}

  @Get('page/by-path')
  @Throttle({ default: { limit: 60, ttl: 60 } })
  async getPageByPath(
    @Query('path') path: string | undefined,
    @Req() request: FastifyRequest,
  ): Promise<WikiApiPageSummary> {
    const token = requireWikiApiToken(request);
    this.tokens.assertScope(token, 'wiki:read');
    const normalizedPath = path?.trim();
    if (!normalizedPath) {
      throw new BadRequestException('path 쿼리 파라미터가 필요합니다.');
    }
    const page = await this.wikiRead.getPageByPath(normalizedPath, token.accountId);
    this.tokens.assertResponseSpace(token, page.spaceId);
    return toPageSummary(page);
  }

  @Get('pages/:id/raw')
  @Throttle({ default: { limit: 60, ttl: 60 } })
  async getPageRaw(
    @Param('id') pageId: string,
    @Query('revisionId') revisionId: string | undefined,
    @Req() request: FastifyRequest,
  ): Promise<WikiRevisionResponse> {
    const token = requireWikiApiToken(request);
    this.tokens.assertScope(token, 'wiki:read');
    await this.tokens.assertPageSpace(token, pageId);
    return this.wikiEdit.getRawPage(
      pageId,
      token.accountId,
      revisionId,
      tokenSpaceOption(token),
    );
  }

  @Post('pages')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  async createPage(
    @Body() body: WikiPageMutationRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: FastifyRequest,
  ): Promise<WikiMutationResponse> {
    const token = requireWikiApiToken(request);
    this.tokens.assertScope(token, 'wiki:create');
    const target = await this.wikiEdit.resolveCreatePageTarget(body);
    this.tokens.assertCreateSpace(token, target.spaceId.toString());
    return this.tokens.idempotent({
      tokenId: token.id,
      key: idempotencyKey,
      method: 'POST',
      route: '/v1/wiki/api/pages',
      body,
      responseStatus: 201,
      action: () => this.wikiEdit.createPage(token.session, body, tokenSpaceOption(token)),
    });
  }

  @Patch('pages/:id')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  async updatePage(
    @Param('id') pageId: string,
    @Body() body: WikiPageMutationRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: FastifyRequest,
  ): Promise<WikiMutationResponse> {
    const token = requireWikiApiToken(request);
    this.tokens.assertScope(token, 'wiki:edit');
    await this.tokens.assertPageSpace(token, pageId);
    return this.tokens.idempotent({
      tokenId: token.id,
      key: idempotencyKey,
      method: 'PATCH',
      route: `/v1/wiki/api/pages/${pageId}`,
      body,
      responseStatus: 200,
      action: () => this.wikiEdit.updatePage(token.session, pageId, body, tokenSpaceOption(token)),
    });
  }
}

function requireWikiApiToken(request: FastifyRequest): AuthenticatedWikiApiToken {
  if (!request.wikiApiToken) {
    throw new Error('Wiki API 토큰 정보가 설정되지 않았습니다.');
  }
  return request.wikiApiToken;
}

function tokenSpaceOption(token: AuthenticatedWikiApiToken): { readonly allowedSpaceId?: bigint } {
  return token.spaceId ? { allowedSpaceId: BigInt(token.spaceId) } : {};
}

function toPageSummary(page: WikiPageResponse): WikiApiPageSummary {
  return {
    id: page.id,
    namespace: page.namespace,
    spaceId: page.spaceId,
    title: page.title,
    displayTitle: page.displayTitle,
    revision: page.revision,
  };
}
