import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
  ForbiddenException
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ServerService } from './server.service';
import type {
  ServerDetail,
  ServerRankingResponse,
  ServerRegistrationPayload,
  ServerStats,
  ServerSummary,
  ServerUpdate
} from '@minewiki/schemas';
import {
  isEdition,
  isServerSort,
  type ServerFilters,
  type ServerSort
} from './server.store';
import { SessionGuard } from '../session/session.guard';
import { CurrentSession } from '../session/session.decorator';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import { ClaimService } from '../claim/claim.service';
import { FileService } from '../file/file.service';
import { serverRegistrationSchema, votifierTargetSchema } from '@minewiki/schemas';
import { PluginCredentialService } from './plugin-credential.service';
import { GuildAccessService } from '../verify/guild-access.service';
import type { ServerWikiContentSettingsInput } from './server-wiki-content-settings';
import {
  ServerWikiCollaboratorService,
  type ServerWikiContentSettingsAuthority,
} from './server-wiki-collaborator.service';

const votifierPayloadSchema = z.object({
  targets: z.array(votifierTargetSchema).min(1)
});

const serverWikiLinkPayloadSchema = z.object({
  serverWikiId: z.string().trim().min(1).optional(),
  spaceId: z.string().trim().min(1).optional(),
  wikiSlug: z.string().trim().min(1).optional()
});

const pluginCredentialPayloadSchema = z.object({
  guildId: z.string().trim().regex(/^\d{5,32}$/),
  endpointUrl: z.string().trim().url().max(512).nullable().optional(),
});

const pluginCredentialStatusSchema = z.object({ enabled: z.boolean() });
const serverWikiLayoutPayloadSchema = z.object({
  layoutKey: z.enum(['docs', 'handbook', 'brand'])
});
const serverWikiSiteSlugPayloadSchema = z.object({
  siteSlug: z.string().trim().toLowerCase().regex(
    /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/,
    '사이트 주소는 영문 소문자, 숫자, 하이픈 조합으로 3~63자여야 합니다.',
  ),
});
const serverWikiContentSettingsPayloadSchema = z.object({
  expectedVersion: z.number().int().min(0),
  contributionPolicySource: z.string().nullable(),
  editHelpSource: z.string().nullable(),
  topNoticeSource: z.string().nullable(),
  bottomNoticeSource: z.string().nullable(),
  requireContributionPolicyAck: z.boolean(),
});

const rankingQuerySchema = z.object({
  edition: z.enum(['java', 'bedrock']).optional(),
  grade: z.enum(['Verified', 'Unverified']).optional(),
  online: z.enum(['true', 'false']).optional(),
  tag: z.string().trim().min(1).max(64).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  sort: z
    .enum([
      'votes24h_desc',
      'votesMonthly_desc',
      'playersOnline_desc',
      'reviews_desc',
      'latest',
      'name_asc',
    ])
    .default('votes24h_desc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

type RequiredServerRegistrationPayload =
  Required<Omit<ServerRegistrationPayload, 'websiteUrl' | 'discordUrl'>> &
    Pick<ServerRegistrationPayload, 'websiteUrl' | 'discordUrl'>;

@Controller({
  path: 'v1/servers'
})
export class ServerController {
  constructor(
    private readonly serverService: ServerService,
    private readonly claimService: ClaimService,
    private readonly files: FileService,
    private readonly pluginCredentials: PluginCredentialService,
    private readonly guildAccess: GuildAccessService,
    private readonly wikiCollaborators: ServerWikiCollaboratorService,
  ) {}

  @Get()
  async list(
    @Query('edition') edition?: ServerFilters['edition'] | string,
    @Query('tag') tag?: string | string[],
    @Query('search') search?: string | string[],
    @Query('sort') sort?: ServerSort | string
  ): Promise<ServerSummary[]> {
    const filters: ServerFilters = {
      edition: isEdition(edition) ? edition : undefined,
      tag: Array.isArray(tag) ? tag.at(0) : tag,
      search: Array.isArray(search) ? search.at(0) : search
    };
    const sortOption: ServerSort = isServerSort(sort) ? sort : 'votes24h_desc';
    return this.serverService.list(filters, sortOption);
  }

  @Get('rankings')
  rankings(
    @Query('edition') edition?: string,
    @Query('grade') grade?: string,
    @Query('tag') tag?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('online') online?: string,
  ): Promise<ServerRankingResponse> {
    const query = rankingQuerySchema.parse({
      edition: edition?.trim() || undefined,
      grade: grade?.trim() || undefined,
      tag: tag?.trim() || undefined,
      search: search?.trim() || undefined,
      sort: sort?.trim() || undefined,
      page: page?.trim() || undefined,
      pageSize: pageSize?.trim() || undefined,
      online: online?.trim() || undefined,
    });
    return this.serverService.rankings({
      edition: query.edition,
      grade: query.grade,
      online: query.online === undefined ? undefined : query.online === 'true',
      tag: query.tag,
      search: query.search,
      sort: query.sort ?? 'votes24h_desc',
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 24,
    });
  }

  @Get(':id')
  async detail(@Param('id') id: string): Promise<ServerDetail> {
    return this.serverService.detail(id);
  }

  @Get(':id/wiki')
  async serverWiki(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.serverService.getServerWikiLink(id);
  }

  @UseGuards(SessionGuard)
  @Get(':id/wiki-layouts')
  async wikiLayouts(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentSession() session: SessionPayload
  ) {
    await this.assertCanManageServer(id, session);
    return this.serverService.getWikiLayoutSettings(id);
  }

  @UseGuards(SessionGuard)
  @Get(':id/wiki-settings')
  async wikiSettings(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentSession() session: SessionPayload
  ) {
    const authority = await this.authorizeWikiContentSettings(id, session);
    const settings = await this.serverService.getWikiContentSettings(id);
    return withWikiSettingsAccess(settings, authority);
  }

  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Patch(':id/wiki-settings')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  async updateWikiSettings(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ) {
    const authority = await this.authorizeWikiContentSettings(id, session);
    const payload = serverWikiContentSettingsPayloadSchema.parse(body) as ServerWikiContentSettingsInput;
    const settings = await this.serverService.updateWikiContentSettings(id, payload, authority.accountId);
    return withWikiSettingsAccess(settings, authority);
  }

  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Patch(':id/wiki-layout')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  async updateWikiLayout(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ) {
    await this.assertCanManageServer(id, session);
    const payload = serverWikiLayoutPayloadSchema.parse(body);
    return this.serverService.updateWikiLayout(id, payload.layoutKey, session.userId);
  }

  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Patch(':id/wiki-site-slug')
  @Throttle({ default: { limit: 6, ttl: 60 } })
  async updateWikiSiteSlug(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ) {
    await this.assertCanManageServer(id, session);
    const payload = serverWikiSiteSlugPayloadSchema.parse(body);
    return this.serverService.updateWikiSiteSlug(id, payload.siteSlug, session.userId);
  }

  @Get(':id/stats')
  async stats(@Param('id', new ParseUUIDPipe()) id: string): Promise<ServerStats> {
    return this.serverService.stats(id);
  }

  @Get(':id/updates')
  async updates(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('limit') limit?: string
  ): Promise<ServerUpdate[]> {
    const parsedLimit = limit ? Number(limit) : undefined;
    return this.serverService.updates(id, parsedLimit);
  }

  @UseGuards(SessionGuard)
  @Post()
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async register(
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ): Promise<ServerDetail> {
    const payload = serverRegistrationSchema.parse(body) as RequiredServerRegistrationPayload;
    return this.serverService.register({
      ...payload,
      registrantAccountId: session.userId
    });
  }

  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Get(':id/plugin-credentials')
  async listPluginCredentials(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentSession() session: SessionPayload
  ) {
    await this.assertCanManageServer(id, session);
    return this.pluginCredentials.list(id);
  }

  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Get(':id/plugin-credentials/:credentialId/events')
  async listPluginCredentialEvents(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
    @Query('limit') limit: string | undefined,
    @CurrentSession() session: SessionPayload
  ) {
    await this.assertCanManageServer(id, session);
    const credential = await this.pluginCredentials.get(id, credentialId);
    await this.guildAccess.assertCanManageGuild(session, credential.guildId);
    return this.pluginCredentials.listEvents(id, credentialId, limit);
  }

  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Post(':id/plugin-credentials')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async createPluginCredential(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ) {
    await this.assertCanManageServer(id, session);
    const payload = pluginCredentialPayloadSchema.parse(body);
    await this.guildAccess.assertCanManageGuild(session, payload.guildId ?? '');
    return this.pluginCredentials.create(
      id,
      payload as { guildId: string; endpointUrl?: string | null },
      session.userId
    );
  }

  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Post(':id/plugin-credentials/:credentialId/rotate')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async rotatePluginCredential(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
    @CurrentSession() session: SessionPayload
  ) {
    await this.assertCanManageServer(id, session);
    const credential = await this.pluginCredentials.get(id, credentialId);
    await this.guildAccess.assertCanManageGuild(session, credential.guildId);
    return this.pluginCredentials.rotate(id, credentialId, session.userId);
  }

  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Patch(':id/plugin-credentials/:credentialId')
  @Throttle({ default: { limit: 10, ttl: 300 } })
  async updatePluginCredential(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('credentialId', new ParseUUIDPipe()) credentialId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ) {
    await this.assertCanManageServer(id, session);
    const payload = pluginCredentialStatusSchema.parse(body);
    if (payload.enabled) {
      const credential = await this.pluginCredentials.get(id, credentialId);
      await this.guildAccess.assertCanManageGuild(session, credential.guildId);
    }
    return this.pluginCredentials.setEnabled(id, credentialId, payload.enabled, session.userId);
  }

  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Post(':id/wiki')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async createServerWiki(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentSession() session: SessionPayload
  ) {
    await this.ensureServerWikiAccess(id, session);
    return this.serverService.createServerWiki(id, session.userId, {
      allowTargetAuthorityBypass: session.permissions?.includes('server.admin') === true,
    });
  }

  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Patch(':id/wiki-link')
  @Throttle({ default: { limit: 10, ttl: 300 } })
  async linkServerWiki(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ) {
    await this.ensureServerWikiAccess(id, session);
    const payload = serverWikiLinkPayloadSchema.parse(body);
    return this.serverService.linkServerWiki(id, payload, session.userId, {
      allowTargetAuthorityBypass: session.permissions?.includes('server.admin') === true,
    });
  }

  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Delete(':id')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentSession() session: SessionPayload
  ) {
    if (
      !(await this.claimService.isOwner(id, session.userId)) &&
      !(await this.claimService.isPendingRegistrant(id, session.userId))
    ) {
      throw new BadRequestException('해당 서버를 제거할 권한이 없습니다.');
    }
    await this.serverService.remove(id, session.userId);
    return { success: true };
  }

  @UseGuards(SessionGuard)
  @Post('assets/images')
  @Throttle({ default: { limit: 10, ttl: 300 } })
  async uploadDescriptionImage(
    @CurrentSession() session: SessionPayload,
    @Body('data') data: string,
    @Body('filename') filename?: string
  ) {
    if (!data) {
      throw new BadRequestException('이미지 데이터가 필요합니다.');
    }
    const stored = await this.files.createImage(session.userId, {
      data,
      filename: filename?.trim() ? filename.trim() : undefined,
      usageContext: 'server_description'
    });
    return {
      id: stored.id,
      url: stored.url,
      publicPath: stored.publicPath,
      mimeType: stored.mimeType,
      width: stored.width,
      height: stored.height,
      size: stored.size
    };
  }

  @UseGuards(SessionGuard)
  @Get(':id/ownership')
  async ownership(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentSession() session: SessionPayload
  ) {
    return { isOwner: await this.claimService.isOwner(id, session.userId) };
  }

  @UseGuards(SessionGuard)
  @Post(':id/banner')
  @Throttle({ default: { limit: 10, ttl: 300 } })
  async uploadBanner(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('data') data: string,
    @CurrentSession() session: SessionPayload
  ) {
    if (
      !(await this.claimService.isOwner(id, session.userId)) &&
      !(await this.claimService.isPendingRegistrant(id, session.userId))
    ) {
      throw new BadRequestException('해당 서버의 배너를 수정할 권한이 없습니다.');
    }
    if (!data) {
      throw new BadRequestException('이미지 데이터가 필요합니다.');
    }
    const stored = await this.serverService.updateBanner(id, session.userId, { data });
    return stored;
  }

  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Patch(':id/vote-policy')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  async updateVotePolicy(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('requiresOwnership') requiresOwnership: boolean,
    @CurrentSession() session: SessionPayload
  ) {
    if (!(await this.canManageServer(id, session))) {
      throw new BadRequestException('해당 서버의 투표 정책을 변경할 권한이 없습니다.');
    }
    return this.serverService.updateVotePolicy(id, Boolean(requiresOwnership));
  }

  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Get(':id/votifier')
  async votifierTargets(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentSession() session: SessionPayload
  ) {
    if (!(await this.canManageServer(id, session))) {
      throw new BadRequestException('해당 서버의 Votifier 설정을 볼 권한이 없습니다.');
    }
    const targets = await this.serverService.listVotifierTargets(id);
    return { targets };
  }

  @RequireStepUp('server_admin')
  @UseGuards(SessionGuard)
  @Patch(':id/votifier')
  @Throttle({ default: { limit: 10, ttl: 300 } })
  async updateVotifierTargets(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ) {
    if (!(await this.canManageServer(id, session))) {
      throw new BadRequestException('해당 서버의 Votifier 설정을 변경할 권한이 없습니다.');
    }
    const payload = votifierPayloadSchema.parse(body);
    await this.serverService.updateVotifierTargets(id, payload.targets);
    return { success: true };
  }

  private async ensureServerWikiAccess(id: string, session: SessionPayload): Promise<void> {
    if (session.permissions?.includes('server.admin') === true) {
      return;
    }
    if (!(await this.claimService.isOwner(id, session.userId))) {
      throw new BadRequestException('해당 서버 위키를 만들거나 연결할 권한이 없습니다.');
    }
  }

  private async canManageServer(id: string, session: SessionPayload): Promise<boolean> {
    return (
      session.permissions?.includes('server.admin') === true ||
      (await this.claimService.isOwner(id, session.userId))
    );
  }

  private async assertCanManageServer(id: string, session: SessionPayload): Promise<void> {
    if (!(await this.canManageServer(id, session))) {
      throw new ForbiddenException('해당 서버의 관리 설정을 변경할 권한이 없습니다.');
    }
  }

  private authorizeWikiContentSettings(
    id: string,
    session: SessionPayload,
  ): Promise<ServerWikiContentSettingsAuthority> {
    return this.wikiCollaborators.authorizeContentSettings(id, {
      accountId: session.userId,
      permissions: session.permissions,
    });
  }
}

function withWikiSettingsAccess<T extends object>(
  settings: T,
  authority: ServerWikiContentSettingsAuthority,
): T & {
  readonly access: {
    readonly canManageContentSettings: true;
    readonly canManageLayout: boolean;
    readonly canManageCollaborators: boolean;
  };
} {
  const hasFullServerAuthority = authority.kind !== 'manager';
  return {
    ...settings,
    access: {
      canManageContentSettings: true,
      canManageLayout: hasFullServerAuthority,
      canManageCollaborators: hasFullServerAuthority,
    },
  };
}
