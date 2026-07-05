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
  UseGuards
} from '@nestjs/common';
import { z } from 'zod';
import { ServerService } from './server.service';
import type {
  ServerDetail,
  ServerRegistrationPayload,
  ServerStats,
  ServerSummary,
  ServerUpdate
} from '@creepervote/schemas';
import {
  isEdition,
  isServerSort,
  type ServerFilters,
  type ServerSort
} from './server.store';
import { SessionGuard } from '../session/session.guard';
import { CurrentSession } from '../session/session.decorator';
import type { SessionPayload } from '../session/session.service';
import { ClaimService } from '../claim/claim.service';
import { decodeBase64 } from '../upload/upload.utils';
import { serverRegistrationSchema, votifierTargetSchema } from '@creepervote/schemas';

const votifierPayloadSchema = z.object({
  targets: z.array(votifierTargetSchema).min(1)
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
    private readonly claimService: ClaimService
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

  @Get(':id')
  async detail(@Param('id') id: string): Promise<ServerDetail> {
    return this.serverService.detail(id);
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
  async register(
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ): Promise<ServerDetail> {
    const payload = serverRegistrationSchema.parse(body) as RequiredServerRegistrationPayload;
    return this.serverService.register({
      ...payload,
      ownerAccountId: session.userId
    });
  }

  @UseGuards(SessionGuard)
  @Delete(':id')
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentSession() session: SessionPayload
  ) {
    if (!(await this.claimService.isOwner(id, session.userId))) {
      throw new BadRequestException('해당 서버를 제거할 권한이 없습니다.');
    }
    await this.serverService.remove(id);
    return { success: true };
  }

  @UseGuards(SessionGuard)
  @Post('assets/images')
  async uploadDescriptionImage(
    @Body('data') data: string,
    @Body('filename') filename?: string
  ) {
    if (!data) {
      throw new BadRequestException('이미지 데이터가 필요합니다.');
    }
    const buffer = decodeBase64(data);
    const stored = await this.serverService.uploadContentImage({
      buffer,
      filename: filename?.trim() ? filename.trim() : undefined
    });
    return {
      url: stored.publicPath,
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
  async uploadBanner(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('data') data: string,
    @CurrentSession() session: SessionPayload
  ) {
    if (!(await this.claimService.isOwner(id, session.userId))) {
      throw new BadRequestException('해당 서버의 배너를 수정할 권한이 없습니다.');
    }
    if (!data) {
      throw new BadRequestException('이미지 데이터가 필요합니다.');
    }
    const buffer = decodeBase64(data);
    const stored = await this.serverService.updateBanner(id, { buffer });
    return stored;
  }

  @UseGuards(SessionGuard)
  @Patch(':id/vote-policy')
  async updateVotePolicy(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('requiresOwnership') requiresOwnership: boolean,
    @CurrentSession() session: SessionPayload
  ) {
    if (!(await this.claimService.isOwner(id, session.userId))) {
      throw new BadRequestException('해당 서버의 투표 정책을 변경할 권한이 없습니다.');
    }
    return this.serverService.updateVotePolicy(id, Boolean(requiresOwnership));
  }

  @UseGuards(SessionGuard)
  @Get(':id/votifier')
  async votifierTargets(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentSession() session: SessionPayload
  ) {
    if (!(await this.claimService.isOwner(id, session.userId))) {
      throw new BadRequestException('해당 서버의 Votifier 설정을 볼 권한이 없습니다.');
    }
    const targets = await this.serverService.listVotifierTargets(id);
    return { targets };
  }

  @UseGuards(SessionGuard)
  @Patch(':id/votifier')
  async updateVotifierTargets(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ) {
    if (!(await this.claimService.isOwner(id, session.userId))) {
      throw new BadRequestException('해당 서버의 Votifier 설정을 변경할 권한이 없습니다.');
    }
    const payload = votifierPayloadSchema.parse(body);
    await this.serverService.updateVotifierTargets(id, payload.targets);
    return { success: true };
  }
}
