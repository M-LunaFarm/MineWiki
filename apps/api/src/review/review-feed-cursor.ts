import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { reviewTagSchema, type ServerReview } from '@minewiki/schemas';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export type ReviewFeedScope = 'public' | 'staff' | 'mine';
export type ReviewVisibilityFilter = 'all' | ServerReview['visibility'];

export interface ReviewFeedCursorBinding {
  readonly scope: ReviewFeedScope;
  readonly serverId: string;
  readonly subject: string;
  readonly visibility: ReviewVisibilityFilter;
  readonly sort: 'wilson' | 'newest';
  readonly ratingFilter: number | null;
  readonly tagFilter: ServerReview['tags'][number] | null;
}

export interface ReviewFeedCursorPosition {
  readonly snapshotAt: string;
  readonly createdAt: string;
  readonly id: string;
  readonly rating: number;
}

const cursorSchema = z.object({
  version: z.literal(2),
  scope: z.enum(['public', 'staff', 'mine']),
  serverId: z.string().uuid(),
  subject: z.string().min(1).max(64),
  visibility: z.enum(['all', 'public', 'staff']),
  sort: z.enum(['wilson', 'newest']),
  ratingFilter: z.number().int().min(1).max(5).nullable(),
  tagFilter: reviewTagSchema.nullable(),
  snapshotAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
}).strict();

type ReviewFeedCursorPayload = z.infer<typeof cursorSchema>;

@Injectable()
export class ReviewFeedCursorCodec {
  constructor(@Optional() private readonly config?: ConfigService) {}

  encode(binding: ReviewFeedCursorBinding, position: ReviewFeedCursorPosition): string {
    const parsed = cursorSchema.parse({
      version: 2,
      ...binding,
      ...position,
    });
    this.assertDates(parsed);
    const payload = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  decode(value: string, binding: ReviewFeedCursorBinding): ReviewFeedCursorPosition {
    try {
      const parts = value.split('.');
      if (parts.length !== 2) throw new Error('shape');
      const [payload, signature] = parts as [string, string];
      const expected = Buffer.from(this.sign(payload));
      const actual = Buffer.from(signature);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new Error('signature');
      }
      const parsed = cursorSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
      this.assertBinding(parsed, binding);
      this.assertDates(parsed);
      return {
        snapshotAt: parsed.snapshotAt,
        createdAt: parsed.createdAt,
        id: parsed.id,
        rating: parsed.rating,
      };
    } catch {
      throw new BadRequestException('유효하지 않거나 다른 리뷰 피드의 커서입니다.');
    }
  }

  private assertBinding(payload: ReviewFeedCursorPayload, binding: ReviewFeedCursorBinding): void {
    if (
      payload.scope !== binding.scope
      || payload.serverId !== binding.serverId
      || payload.subject !== binding.subject
      || payload.visibility !== binding.visibility
      || payload.sort !== binding.sort
      || payload.ratingFilter !== binding.ratingFilter
      || payload.tagFilter !== binding.tagFilter
    ) {
      throw new Error('binding');
    }
  }

  private assertDates(payload: ReviewFeedCursorPayload): void {
    const snapshotAt = new Date(payload.snapshotAt);
    const createdAt = new Date(payload.createdAt);
    if (createdAt > snapshotAt || snapshotAt.getTime() > Date.now() + 60_000) {
      throw new BadRequestException('리뷰 피드 커서의 시간 범위가 올바르지 않습니다.');
    }
  }

  private sign(payload: string): string {
    const key = this.config?.get('APP_ENCRYPTION_KEY')
      ?? process.env.APP_ENCRYPTION_KEY
      ?? 'minewiki-review-feed-test-key';
    return createHmac('sha256', key)
      .update(`minewiki:review-feed:v2:${payload}`)
      .digest('base64url');
  }
}
