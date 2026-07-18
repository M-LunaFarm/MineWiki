import { BadRequestException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { ServerWikiReleaseCandidatePageKind } from './server-wiki-release-candidate';

export interface ServerWikiReleaseManifestCursorBinding {
  readonly candidateId: string;
  readonly candidateToken: string;
  readonly serverWikiId: string;
  readonly spaceId: string;
  readonly kinds: readonly ServerWikiReleaseCandidatePageKind[];
}

const pageIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/u);
const cursorSchema = z.object({
  version: z.literal(1),
  candidateId: pageIdSchema,
  candidateToken: z.string().regex(/^[a-f0-9]{64}$/u),
  serverWikiId: pageIdSchema,
  spaceId: pageIdSchema,
  kinds: z.array(z.enum(['added', 'updated', 'moved', 'removed', 'unchanged'])).min(1).max(5),
  lastPageId: pageIdSchema,
}).strict();

@Injectable()
export class ServerWikiReleaseManifestCursorCodec {
  constructor(@Optional() private readonly config?: ConfigService) {}

  encode(binding: ServerWikiReleaseManifestCursorBinding, lastPageId: string): string {
    const parsed = cursorSchema.parse({ version: 1, ...binding, lastPageId });
    const payload = Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  decode(value: string, binding: ServerWikiReleaseManifestCursorBinding): string {
    try {
      const parts = value.split('.');
      if (parts.length !== 2) throw new Error('shape');
      const [payload, signature] = parts as [string, string];
      const expected = Buffer.from(this.sign(payload));
      const actual = Buffer.from(signature);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('signature');
      const parsed = cursorSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
      if (
        parsed.candidateId !== binding.candidateId
        || parsed.candidateToken !== binding.candidateToken
        || parsed.serverWikiId !== binding.serverWikiId
        || parsed.spaceId !== binding.spaceId
        || parsed.kinds.join(',') !== binding.kinds.join(',')
      ) throw new Error('binding');
      return parsed.lastPageId;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new BadRequestException('유효하지 않거나 다른 릴리스 후보의 문서 커서입니다.');
    }
  }

  private sign(payload: string): string {
    const key = this.config?.get('APP_ENCRYPTION_KEY') ?? process.env.APP_ENCRYPTION_KEY;
    if (!key) {
      throw new ServiceUnavailableException('Release manifest cursor signing is not configured.');
    }
    return createHmac('sha256', key)
      .update(`minewiki:server-wiki-release-manifest:v1:${payload}`)
      .digest('base64url');
  }
}
