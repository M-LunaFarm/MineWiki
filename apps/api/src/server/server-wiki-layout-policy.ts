export const SERVER_WIKI_LAYOUTS = [
  {
    key: 'docs',
    conceptNumber: 3,
    name: 'Docs',
    description: '문서 탐색과 가독성에 집중한 기본 GitBook형 레이아웃',
    tier: 'free',
  },
  {
    key: 'handbook',
    conceptNumber: 1,
    name: 'Handbook',
    description: '서버 핸드북의 정보 구조를 강조하는 프리미엄 레이아웃',
    tier: 'premium',
  },
  {
    key: 'brand',
    conceptNumber: 2,
    name: 'Brand',
    description: '서버 브랜딩과 핵심 정보를 강조하는 프리미엄 레이아웃',
    tier: 'premium',
  },
] as const;

export type ServerWikiLayoutKey = (typeof SERVER_WIKI_LAYOUTS)[number]['key'];

export interface ServerWikiLayoutEntitlementWindow {
  readonly layoutKey: string;
  readonly status: string;
  readonly startsAt: Date;
  readonly expiresAt: Date | null;
}

export function isServerWikiLayoutKey(value: string): value is ServerWikiLayoutKey {
  return SERVER_WIKI_LAYOUTS.some((layout) => layout.key === value);
}

export function isActiveServerWikiLayoutEntitlement(
  entitlement: ServerWikiLayoutEntitlementWindow,
  layoutKey: ServerWikiLayoutKey,
  now = new Date(),
): boolean {
  return layoutKey !== 'docs' &&
    entitlement.layoutKey === layoutKey &&
    entitlement.status === 'active' &&
    entitlement.startsAt.getTime() <= now.getTime() &&
    (entitlement.expiresAt === null || entitlement.expiresAt.getTime() > now.getTime());
}

export function resolveEffectiveServerWikiLayout(
  selectedLayoutKey: string,
  entitlements: readonly ServerWikiLayoutEntitlementWindow[],
  now = new Date(),
): ServerWikiLayoutKey {
  if (!isServerWikiLayoutKey(selectedLayoutKey) || selectedLayoutKey === 'docs') return 'docs';
  return entitlements.some((entitlement) =>
    isActiveServerWikiLayoutEntitlement(entitlement, selectedLayoutKey, now),
  ) ? selectedLayoutKey : 'docs';
}
