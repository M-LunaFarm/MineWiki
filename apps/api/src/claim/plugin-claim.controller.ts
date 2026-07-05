import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import { ClaimService } from './claim.service';
import { PrismaService } from '../common/prisma.service';

const payloadSchema = z.object({
  serverId: z.string().uuid(),
  token: z.string().min(1),
});
const CLAIM_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

@Controller('plugin/claim')
export class PluginClaimController {
  constructor(
    private readonly claims: ClaimService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('complete')
  async complete(@Body() body: unknown) {
    const parsed = payloadSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException('serverId와 token을 확인해주세요.');
    }
    const payload = parsed.data;
    const method = await this.prisma.serverClaimMethod.findUnique({
      where: {
        serverId_method: {
          serverId: payload.serverId,
          method: 'plugin',
        },
      },
      include: {
        server: {
          select: {
            ownerAccountId: true,
          },
        },
      },
    });
    if (!method) {
      throw new BadRequestException('먼저 플러그인 검증 토큰을 발급해주세요.');
    }
    if (
      method.status === 'expired' ||
      (method.verifiedAt && Date.now() - method.verifiedAt.getTime() > CLAIM_VERIFICATION_TTL_MS)
    ) {
      throw new BadRequestException('플러그인 검증 토큰을 다시 발급해주세요.');
    }
    if (!method.accountId && !method.server.ownerAccountId) {
      throw new BadRequestException('플러그인 검증 토큰을 다시 발급해주세요.');
    }
    if (
      method.accountId &&
      method.server.ownerAccountId &&
      method.accountId !== method.server.ownerAccountId
    ) {
      throw new BadRequestException('현재 서버 소유 계정에서 토큰을 다시 발급해주세요.');
    }
    if (method.token !== payload.token.trim()) {
      throw new BadRequestException('플러그인 검증 토큰이 일치하지 않습니다.');
    }
    await this.claims.applyVerificationResult(payload.serverId, 'plugin', {
      status: 'verified',
      checkedAt: new Date().toISOString(),
      note: 'plugin_callback_confirmed',
    });
    return { success: true };
  }
}
