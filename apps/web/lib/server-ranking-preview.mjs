export function serverRankingRequestFromFilters(filters, overrides = {}) {
  return {
    edition: filters.edition === 'all' ? undefined : filters.edition,
    grade: filters.grade === 'all' ? undefined : filters.grade,
    online: filters.online === 'online' ? true : undefined,
    tag: filters.tags?.[0],
    search: filters.search?.trim() || undefined,
    sort: overrides.sort ?? filters.sort,
    page: overrides.page ?? filters.page ?? 1,
    pageSize: overrides.pageSize ?? 6,
    ...(overrides.rankEpoch ? { rankEpoch: overrides.rankEpoch } : {}),
  };
}

export function shouldLoadUnrankedServerPreview(ranking, sort) {
  return sort === 'votes24h_desc'
    && ranking?.rankStatus === 'empty'
    && ranking?.total === 0
    && ranking?.unrankedCount > 0;
}

export function unrankedServerBrowseHref(filters) {
  const params = new URLSearchParams();
  if (filters.search?.trim()) params.set('search', filters.search.trim());
  if (filters.edition && filters.edition !== 'all') params.set('edition', filters.edition);
  if (filters.grade && filters.grade !== 'all') params.set('grade', filters.grade);
  if (filters.online === 'online') params.set('online', 'true');
  if (filters.tags?.[0]) params.set('tag', filters.tags[0]);
  params.set('sort', 'latest');
  return `/servers?${params.toString()}`;
}
