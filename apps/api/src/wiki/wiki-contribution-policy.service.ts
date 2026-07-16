import {
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';

export interface WikiPolicyAcceptance {
  readonly version?: number;
  readonly accepted?: boolean;
}

type PolicyStore = PrismaService | Prisma.TransactionClient;

@Injectable()
export class WikiContributionPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async assertAccepted(
    spaceId: bigint,
    acceptance?: WikiPolicyAcceptance,
    store: PolicyStore = this.prisma,
  ): Promise<number | null> {
    const policy = await this.findPolicy(spaceId, store);
    if (!policy?.required) return null;
    if (!acceptance?.accepted || !Number.isInteger(acceptance.version)) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'WIKI_CONTRIBUTION_POLICY_ACCEPTANCE_REQUIRED',
        message: '이 서버 위키의 기여 정책을 확인하고 동의해야 합니다.',
        policyVersion: policy.version,
      });
    }
    if (acceptance.version !== policy.version) throw this.changed(policy.version);
    return policy.version;
  }

  async assertStoredVersionCurrent(
    spaceId: bigint,
    storedVersion: number | null,
    store: PolicyStore = this.prisma,
  ): Promise<void> {
    const policy = await this.findPolicy(spaceId, store);
    if (!policy?.required) return;
    if (storedVersion !== policy.version) throw this.changed(policy.version);
  }

  private async findPolicy(spaceId: bigint, store: PolicyStore) {
    const delegate = (store as PolicyStore & {
      serverWiki?: Prisma.TransactionClient['serverWiki'];
    }).serverWiki;
    if (!delegate?.findFirst) return null;
    const serverWiki = await delegate.findFirst({
      where: { spaceId },
      select: {
        contributionPolicySource: true,
        requireContributionPolicyAck: true,
        contributionPolicyVersion: true,
      },
    });
    if (!serverWiki) return null;
    return {
      required: serverWiki.requireContributionPolicyAck
        && Boolean(serverWiki.contributionPolicySource?.trim()),
      version: serverWiki.contributionPolicyVersion,
    };
  }

  private changed(policyVersion: number): ConflictException {
    return new ConflictException({
      statusCode: 409,
      code: 'WIKI_CONTRIBUTION_POLICY_CHANGED',
      message: '기여 정책이 변경되었습니다. 최신 정책을 다시 확인해 주세요.',
      policyVersion,
    });
  }
}
