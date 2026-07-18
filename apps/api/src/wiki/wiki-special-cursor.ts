import { BadRequestException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export interface WikiSpecialCursorBinding {
  readonly type: string;
  readonly namespace: string;
  readonly generation: string | null;
  readonly viewerScope: string;
}

export type WikiSpecialCursorPosition =
  | { readonly kind: 'snapshot'; readonly offset: number }
  | {
      readonly kind: 'indexed';
      readonly snapshotAt: string;
      readonly sortValue: string;
      readonly pageId: string;
    };

const bindingFields = {
  type: z.string().min(1).max(32),
  namespace: z.string().max(32),
  generation: z.string().max(64).nullable(),
  viewerScope: z.string().min(1).max(128),
};

const cursorSchema = z.discriminatedUnion('kind', [
  z.object({
    version: z.literal(1),
    ...bindingFields,
    kind: z.literal('snapshot'),
    offset: z.number().int().min(1).max(50_000),
  }).strict(),
  z.object({
    version: z.literal(1),
    ...bindingFields,
    kind: z.literal('indexed'),
    snapshotAt: z.string().datetime(),
    sortValue: z.string().min(1).max(64),
    pageId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
  }).strict(),
]);

type WikiSpecialCursorPayload = z.infer<typeof cursorSchema>;

@Injectable()
export class WikiSpecialCursorCodec {
  constructor(@Optional() private readonly config?: ConfigService) {}

  encode(binding: WikiSpecialCursorBinding, position: WikiSpecialCursorPosition): string {
    const parsed = cursorSchema.parse({ version: 1, ...binding, ...position });
    this.assertPosition(parsed);
    const payload = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  decode(value: string, binding: WikiSpecialCursorBinding): WikiSpecialCursorPosition {
    try {
      const parts = value.split('.');
      if (parts.length !== 2) throw new Error('shape');
      const [payload, signature] = parts as [string, string];
      const expected = Buffer.from(this.sign(payload));
      const actual = Buffer.from(signature);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('signature');
      const parsed = cursorSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
      if (
        parsed.type !== binding.type
        || parsed.namespace !== binding.namespace
        || parsed.generation !== binding.generation
        || parsed.viewerScope !== binding.viewerScope
      ) throw new Error('binding');
      this.assertPosition(parsed);
      return parsed.kind === 'snapshot'
        ? { kind: 'snapshot', offset: parsed.offset }
        : {
            kind: 'indexed',
            snapshotAt: parsed.snapshotAt,
            sortValue: parsed.sortValue,
            pageId: parsed.pageId,
          };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new BadRequestException('유효하지 않거나 다른 특수 문서 목록의 커서입니다.');
    }
  }

  private assertPosition(payload: WikiSpecialCursorPayload): void {
    if (payload.kind !== 'indexed') return;
    const snapshotAt = new Date(payload.snapshotAt);
    if (!Number.isFinite(snapshotAt.getTime()) || snapshotAt.getTime() > Date.now() + 60_000) {
      throw new BadRequestException('특수 문서 커서의 시간 범위가 올바르지 않습니다.');
    }
    if (payload.type === 'long' || payload.type === 'short') {
      const size = Number(payload.sortValue);
      if (!Number.isSafeInteger(size) || size < 0) throw new BadRequestException('특수 문서 커서가 올바르지 않습니다.');
      return;
    }
    const updatedAt = new Date(payload.sortValue);
    if (!Number.isFinite(updatedAt.getTime()) || updatedAt > snapshotAt) {
      throw new BadRequestException('특수 문서 커서가 올바르지 않습니다.');
    }
  }

  private sign(payload: string): string {
    const key = this.config?.get('APP_ENCRYPTION_KEY') ?? process.env.APP_ENCRYPTION_KEY;
    if (!key) throw new ServiceUnavailableException('Special document cursor signing is not configured.');
    return createHmac('sha256', key)
      .update(`minewiki:wiki-special:v1:${payload}`)
      .digest('base64url');
  }
}
