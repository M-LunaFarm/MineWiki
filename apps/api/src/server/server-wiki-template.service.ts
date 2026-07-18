import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parseMarkup } from '@minewiki/wiki-core';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import { WikiProfileService } from '../wiki/wiki-profile.service';

const TEMPLATE_CONTENT_LIMIT = 256 * 1024;

export interface ServerWikiTemplateInput {
  readonly key: string;
  readonly title: string;
  readonly description?: string | null;
  readonly defaultCategory?: string | null;
  readonly contentRaw: string;
}

export interface ServerWikiTemplateUpdateInput extends ServerWikiTemplateInput {
  readonly expectedVersion: number;
}

export interface ServerWikiTemplateSummary {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly description: string | null;
  readonly defaultCategory: string | null;
  readonly contentRaw: string;
  readonly version: number;
  readonly updatedAt: string;
}

@Injectable()
export class ServerWikiTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiProfiles: WikiProfileService,
    @Optional() private readonly events?: BusinessEventService,
  ) {}

  async list(serverId: string): Promise<ServerWikiTemplateSummary[]> {
    const target = await this.resolveTarget(serverId);
    const rows = await this.prisma.documentTemplate.findMany({
      where: { spaceId: target.spaceId, templateScope: 'space', status: 'active' },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      take: 80,
    });
    return rows.map(toSummary);
  }

  async create(
    serverId: string,
    accountId: string,
    input: ServerWikiTemplateInput,
  ): Promise<ServerWikiTemplateSummary> {
    const target = await this.resolveTarget(serverId);
    const actor = await this.wikiProfiles.ensureWikiProfile(accountId);
    const clean = this.validate(input);
    let row;
    try {
      row = await this.prisma.documentTemplate.create({
        data: {
          spaceId: target.spaceId,
          templateKey: clean.key,
          title: clean.title,
          description: clean.description,
          templateScope: 'space',
          targetArea: 'official',
          defaultCategory: clean.defaultCategory,
          contentRaw: clean.contentRaw,
          createdBy: actor.id,
          updatedBy: actor.id,
          status: 'active',
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw new ConflictException('같은 키의 서버 위키 문서 양식이 이미 있습니다.');
      throw error;
    }
    await this.audit('server.wiki.template.create', accountId, actor.id, row.id, target, clean.key);
    return toSummary(row);
  }

  async update(
    serverId: string,
    templateId: string,
    accountId: string,
    input: ServerWikiTemplateUpdateInput,
  ): Promise<ServerWikiTemplateSummary> {
    const target = await this.resolveTarget(serverId);
    const actor = await this.wikiProfiles.ensureWikiProfile(accountId);
    const id = parseId(templateId);
    const current = await this.findActive(target.spaceId, id);
    if (current.version !== input.expectedVersion) throw staleTemplate(current.version);
    const clean = this.validate(input);
    const now = new Date();
    try {
      const changed = await this.prisma.documentTemplate.updateMany({
        where: { id, spaceId: target.spaceId, templateScope: 'space', status: 'active', version: input.expectedVersion },
        data: {
          templateKey: clean.key,
          title: clean.title,
          description: clean.description,
          defaultCategory: clean.defaultCategory,
          contentRaw: clean.contentRaw,
          targetArea: 'official',
          updatedBy: actor.id,
          updatedAt: now,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw staleTemplate(current.version + 1);
    } catch (error) {
      if (isUniqueConflict(error)) throw new ConflictException('같은 키의 서버 위키 문서 양식이 이미 있습니다.');
      throw error;
    }
    const row = await this.findActive(target.spaceId, id);
    await this.audit('server.wiki.template.update', accountId, actor.id, row.id, target, clean.key);
    return toSummary(row);
  }

  async archive(
    serverId: string,
    templateId: string,
    accountId: string,
    expectedVersion: number,
  ): Promise<{ readonly id: string; readonly status: 'archived' }> {
    const target = await this.resolveTarget(serverId);
    const actor = await this.wikiProfiles.ensureWikiProfile(accountId);
    const id = parseId(templateId);
    const current = await this.findActive(target.spaceId, id);
    if (current.version !== expectedVersion) throw staleTemplate(current.version);
    const changed = await this.prisma.documentTemplate.updateMany({
      where: { id, spaceId: target.spaceId, templateScope: 'space', status: 'active', version: expectedVersion },
      data: { status: 'archived', updatedBy: actor.id, updatedAt: new Date(), version: { increment: 1 } },
    });
    if (changed.count !== 1) throw staleTemplate(current.version + 1);
    await this.audit('server.wiki.template.archive', accountId, actor.id, id, target, current.templateKey);
    return { id: id.toString(), status: 'archived' };
  }

  private async resolveTarget(serverId: string) {
    const target = await this.prisma.serverWiki.findFirst({
      where: { voteServerId: serverId, status: { not: 'deleted' } },
      select: { id: true, spaceId: true, voteServerId: true },
    });
    if (!target?.voteServerId) throw new NotFoundException('연결된 서버 위키를 찾을 수 없습니다.');
    return target;
  }

  private async findActive(spaceId: bigint, id: bigint) {
    const row = await this.prisma.documentTemplate.findFirst({
      where: { id, spaceId, templateScope: 'space', status: 'active' },
    });
    if (!row) throw new NotFoundException('서버 위키 문서 양식을 찾을 수 없습니다.');
    return row;
  }

  private validate(input: ServerWikiTemplateInput): ServerWikiTemplateInput {
    const key = input.key.trim().toLowerCase();
    const title = input.title.trim();
    const description = input.description?.trim() || null;
    const defaultCategory = input.defaultCategory?.trim() || null;
    const contentRaw = input.contentRaw.replaceAll('\r\n', '\n').trim();
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/u.test(key)) throw new BadRequestException('양식 키는 영문 소문자, 숫자, 밑줄, 하이픈으로 2~64자여야 합니다.');
    if (!title || title.length > 255) throw new BadRequestException('양식 이름은 1~255자여야 합니다.');
    if (description && Buffer.byteLength(description, 'utf8') > 2_000) throw new BadRequestException('양식 설명이 너무 깁니다.');
    if (defaultCategory && defaultCategory.length > 255) throw new BadRequestException('기본 분류가 너무 깁니다.');
    if (!contentRaw) throw new BadRequestException('양식 본문을 입력해 주세요.');
    if (Buffer.byteLength(contentRaw, 'utf8') > TEMPLATE_CONTENT_LIMIT) throw new BadRequestException('양식 본문은 256 KiB 이하여야 합니다.');
    const parsed = parseMarkup(contentRaw);
    if (parsed.blockingErrors.length > 0) {
      throw new BadRequestException(`문서 양식에 저장할 수 없는 마크업이 있습니다: ${parsed.blockingErrors.join(', ')}`);
    }
    return { key, title, description, defaultCategory, contentRaw };
  }

  private async audit(
    action: string,
    actorAccountId: string,
    actorProfileId: bigint,
    templateId: bigint,
    target: { readonly voteServerId: string | null; readonly spaceId: bigint },
    templateKey: string,
  ): Promise<void> {
    await this.events?.audit(action, {
      category: 'wiki',
      actorAccountId,
      actorProfileId,
      subjectType: 'document_template',
      subjectId: templateId.toString(),
      metadata: { serverId: target.voteServerId, spaceId: target.spaceId.toString(), templateKey },
    });
  }
}

function parseId(value: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new BadRequestException('문서 양식 ID가 올바르지 않습니다.');
  return BigInt(value);
}

function staleTemplate(currentVersion: number): ConflictException {
  return new ConflictException({
    statusCode: 409,
    code: 'SERVER_WIKI_TEMPLATE_CONFLICT',
    message: '다른 관리자가 문서 양식을 먼저 변경했습니다.',
    currentVersion,
  });
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function toSummary(row: {
  readonly id: bigint;
  readonly templateKey: string;
  readonly title: string;
  readonly description: string | null;
  readonly defaultCategory: string | null;
  readonly contentRaw: string;
  readonly version: number;
  readonly updatedAt: Date;
}): ServerWikiTemplateSummary {
  return {
    id: row.id.toString(),
    key: row.templateKey,
    title: row.title,
    description: row.description,
    defaultCategory: row.defaultCategory,
    contentRaw: row.contentRaw,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}
