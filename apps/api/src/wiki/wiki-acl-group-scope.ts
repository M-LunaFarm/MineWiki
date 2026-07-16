import type { Prisma } from '@prisma/client';

export interface WikiAclGroupScope {
  readonly scopeType: string;
  readonly spaceId: bigint | null;
}

export function aclGroupScopeMatches(
  group: WikiAclGroupScope,
  resourceSpaceId: bigint | null | undefined
): boolean {
  if (group.scopeType === 'site') return group.spaceId === null;
  return group.scopeType === 'space' && group.spaceId !== null && group.spaceId === resourceSpaceId;
}

export function activeAclGroupScopeWhere(
  resourceSpaceId: bigint | null | undefined
): Prisma.AclGroupWhereInput {
  return {
    status: 'active',
    OR: [
      { scopeType: 'site', spaceId: null },
      ...(resourceSpaceId === null || resourceSpaceId === undefined
        ? []
        : [{ scopeType: 'space', spaceId: resourceSpaceId }])
    ]
  };
}
