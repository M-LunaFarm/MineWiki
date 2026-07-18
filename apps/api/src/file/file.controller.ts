import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentSession } from '../session/session.decorator';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import {
  FileService,
  type FileImageUploadResponse,
  type FileMetadataResponse,
  type WikiFileVersionResponse,
} from './file.service';

@Controller('v1/files')
export class FileController {
  constructor(private readonly files: FileService) {}

  @Post('images')
  @Throttle({ default: { limit: 10, ttl: 300 } })
  @UseGuards(SessionGuard)
  uploadImage(
    @CurrentSession() session: SessionPayload,
    @Body() body: {
      data?: string;
      filename?: string;
      usageContext?: string;
      visibility?: string;
      license?: string;
      sourceUrl?: string;
      sourceText?: string;
      linkedResourceType?: string;
      linkedResourceId?: string;
      replaceFileId?: string;
    }
  ): Promise<FileImageUploadResponse> {
    return this.files.createImage(session.userId, body, session);
  }

  @Get()
  @UseGuards(OptionalSessionGuard)
  listFiles(
    @Req() request: FastifyRequest,
    @Query('search') search?: string,
    @Query('usageContext') usageContext?: string,
    @Query('limit') limit?: string
  ): Promise<FileMetadataResponse[]> {
    return this.files.listFiles({
      session: request.sessionPayload ?? null,
      search,
      usageContext,
      limit
    });
  }

  @Get(':id')
  @UseGuards(OptionalSessionGuard)
  getFile(@Param('id') id: string, @Req() request: FastifyRequest): Promise<FileMetadataResponse> {
    return this.files.getFile(id, request.sessionPayload ?? null);
  }

  @Get(':id/versions')
  @UseGuards(OptionalSessionGuard)
  listWikiFileVersions(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
  ): Promise<WikiFileVersionResponse[]> {
    return this.files.listWikiFileVersions(id, request.sessionPayload ?? null);
  }

  @Post(':id/versions/:versionId/restore')
  @Throttle({ default: { limit: 10, ttl: 60 } })
  @UseGuards(SessionGuard)
  restoreWikiFileVersion(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
    @Body() body: { expectedCurrentVersionNo?: number },
    @CurrentSession() session: SessionPayload,
  ) {
    return this.files.restoreWikiFileVersion(
      id,
      versionId,
      Number(body.expectedCurrentVersionNo),
      session,
    );
  }

  @Get(':id/raw')
  @UseGuards(OptionalSessionGuard)
  async getRawFile(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<StreamableFile | undefined> {
    const raw = await this.files.getRawFile(id, request.sessionPayload ?? null);
    return this.sendRawFile(raw, reply);
  }

  @Get('public/:filename/raw')
  @UseGuards(OptionalSessionGuard)
  async getRawFileByFilename(
    @Param('filename') filename: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<StreamableFile | undefined> {
    const raw = await this.files.getRawFileByFilename(filename, request.sessionPayload ?? null);
    return this.sendRawFile(raw, reply);
  }

  private sendRawFile(
    raw: Awaited<ReturnType<FileService['getRawFile']>>,
    reply: FastifyReply
  ): StreamableFile | undefined {
    reply.header('Cache-Control', raw.cacheControl);
    if (raw.redirectUrl) {
      reply.redirect(raw.redirectUrl, 302);
      return undefined;
    }
    reply.header('Content-Type', raw.mimeType);
    reply.header('Content-Disposition', `inline; filename="${raw.filename.replace(/"/g, '')}"`);
    return new StreamableFile(raw.buffer!);
  }

  @Delete(':id')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  @UseGuards(SessionGuard)
  deleteFile(
    @Param('id') id: string,
    @CurrentSession() session: SessionPayload
  ): Promise<{ deleted: true }> {
    return this.files.deleteFile(id, session);
  }
}
