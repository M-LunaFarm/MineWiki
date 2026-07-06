import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UseGuards
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentSession } from '../session/session.decorator';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import {
  FileService,
  type FileImageUploadResponse,
  type FileMetadataResponse
} from './file.service';

@Controller('v1/files')
export class FileController {
  constructor(private readonly files: FileService) {}

  @Post('images')
  @UseGuards(SessionGuard)
  uploadImage(
    @CurrentSession() session: SessionPayload,
    @Body() body: { data?: string; filename?: string; usageContext?: string; visibility?: string }
  ): Promise<FileImageUploadResponse> {
    return this.files.createImage(session.userId, body);
  }

  @Get(':id')
  @UseGuards(OptionalSessionGuard)
  getFile(@Param('id') id: string, @Req() request: FastifyRequest): Promise<FileMetadataResponse> {
    return this.files.getFile(id, request.sessionPayload ?? null);
  }

  @Get(':id/raw')
  @UseGuards(OptionalSessionGuard)
  async getRawFile(
    @Param('id') id: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply
  ): Promise<StreamableFile | undefined> {
    const raw = await this.files.getRawFile(id, request.sessionPayload ?? null);
    reply.header('Cache-Control', raw.cacheControl);
    if (raw.redirectUrl) {
      reply.redirect(302, raw.redirectUrl);
      return undefined;
    }
    reply.header('Content-Type', raw.mimeType);
    reply.header('Content-Disposition', `inline; filename="${raw.filename.replace(/"/g, '')}"`);
    return new StreamableFile(raw.buffer!);
  }

  @Delete(':id')
  @UseGuards(SessionGuard)
  deleteFile(
    @Param('id') id: string,
    @CurrentSession() session: SessionPayload
  ): Promise<{ deleted: true }> {
    return this.files.deleteFile(id, session);
  }
}
