export function formatCombinedSearchSummary({ serverTotal, wikiShown, wikiHasMore, continued }) {
  if (continued) return `위키 검색을 이어서 보는 중 · 현재 ${formatCount(wikiShown)}개`;
  const shown = serverTotal + wikiShown;
  return `검색 결과 ${formatCount(shown)}개${wikiHasMore ? ' 이상' : ''}`;
}

export function formatWikiResultBadge({ wikiShown, wikiHasMore, continued }) {
  return `${formatCount(wikiShown)}${wikiHasMore && !continued ? '+' : ''}`;
}

function formatCount(value) {
  return Math.max(0, Number(value) || 0).toLocaleString('ko-KR');
}
