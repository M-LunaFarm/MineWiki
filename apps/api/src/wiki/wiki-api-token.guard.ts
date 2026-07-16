import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  WikiApiTokenService,
  type AuthenticatedWikiApiToken,
} from './wiki-api-token.service';

declare module 'fastify' {
  interface FastifyRequest {
    wikiApiToken?: AuthenticatedWikiApiToken;
  }
}

@Injectable()
export class WikiApiTokenGuard implements CanActivate {
  constructor(private readonly tokens: WikiApiTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (hasSessionCookie(request.headers.cookie)) {
      throw new UnauthorizedException(
        'Wiki API 요청에는 세션 쿠키를 함께 사용할 수 없습니다.',
      );
    }

    const authorization = request.headers.authorization?.trim();
    const match = authorization ? /^Bearer ([^\s,]+)$/.exec(authorization) : null;
    if (!match) {
      throw new UnauthorizedException(
        'Authorization 헤더에 Bearer Wiki API 토큰을 보내 주세요.',
      );
    }

    request.wikiApiToken = await this.tokens.authenticate(
      match[1]!,
      request.clientIp ?? null,
    );
    return true;
  }
}

function hasSessionCookie(cookieHeader: string | undefined): boolean {
  return Boolean(cookieHeader && /(?:^|;\s*)mw_session=/.test(cookieHeader));
}
