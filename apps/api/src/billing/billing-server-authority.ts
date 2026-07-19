import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { isServerOwnershipManagementSuspended } from '@minewiki/schemas';

interface BillingAuthorityStore {
  readonly server: {
    findUnique(input: {
      readonly where: { readonly id: string };
      readonly select: {
        readonly ownerAccountId: true;
        readonly ownershipChallengeSuspendedAt: true;
      };
    }): Promise<{
      readonly ownerAccountId: string | null;
      readonly ownershipChallengeSuspendedAt: Date | null;
    } | null>;
  };
}

export async function assertActiveBillingOwner(
  store: BillingAuthorityStore,
  serverId: string,
  accountId: string,
): Promise<void> {
  const server = await store.server.findUnique({
    where: { id: serverId },
    select: {
      ownerAccountId: true,
      ownershipChallengeSuspendedAt: true,
    },
  });
  if (!server) throw new NotFoundException('Server not found.');
  if (server.ownerAccountId !== accountId || isServerOwnershipManagementSuspended(server)) {
    throw new ForbiddenException('Active server owner access is required for billing.');
  }
}
