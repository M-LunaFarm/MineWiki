export const specialQualityPages = [
  { kind: 'needs_check', label: '검증 필요 문서' },
  { kind: 'stub', label: '토막글' },
  { kind: 'uncategorized', label: '분류 없는 문서' },
  { kind: 'broken-links', label: '깨진 링크' },
  { kind: 'needed-pages', label: '필요한 문서' },
  { kind: 'page-requests', label: '문서 작성 요청' },
  { kind: 'missing-status', label: '문서 상태 없는 문서' },
  { kind: 'missing-infobox', label: '정보상자 없는 문서' },
  { kind: 'no-internal-links', label: '내부 링크 없는 문서' },
  { kind: 'old-mods', label: '오래된 모드 문서' },
  { kind: 'server-missing-address', label: '주소 없는 서버 문서' },
  { kind: 'outdated', label: '오래된 문서' }
] as const;

export type SpecialQualityKind = typeof specialQualityPages[number]['kind'];

export function isSpecialQualityKind(kind: string): kind is SpecialQualityKind {
  return specialQualityPages.some((page) => page.kind === kind);
}

export function specialQualityLabel(kind: SpecialQualityKind) {
  return specialQualityPages.find((page) => page.kind === kind)?.label ?? kind;
}
