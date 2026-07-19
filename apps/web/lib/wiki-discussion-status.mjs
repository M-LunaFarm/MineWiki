export const WIKI_DISCUSSION_STATUS_FILTERS = Object.freeze([
  { value: 'all', label: '전체' },
  { value: 'active', label: '진행 중' },
  { value: 'open', label: '열림' },
  { value: 'paused', label: '일시 중지' },
  { value: 'closed', label: '닫힘' },
]);

export const WIKI_RECENT_DISCUSSION_SORTS = Object.freeze([
  { value: 'newest', label: '최근 활동순' },
  { value: 'oldest', label: '오래된 활동순' },
]);

export function normalizeWikiRecentDiscussionFilters(input = {}) {
  const status = WIKI_DISCUSSION_STATUS_FILTERS.some((item) => item.value === input.status) ? input.status : 'all';
  const sort = WIKI_RECENT_DISCUSSION_SORTS.some((item) => item.value === input.sort) ? input.sort : 'newest';
  return { status, sort };
}

export function wikiRecentDiscussionQuery(input = {}) {
  const filters = normalizeWikiRecentDiscussionFilters(input);
  const params = new URLSearchParams({ limit: '30', status: filters.status, sort: filters.sort });
  if (input.cursor) params.set('cursor', input.cursor);
  if (input.serverSlug) params.set('serverSlug', input.serverSlug);
  return params.toString();
}

export function wikiRecentDiscussionHref(status, sort, basePath = '/wiki/discussions') {
  const filters = normalizeWikiRecentDiscussionFilters({ status, sort });
  const params = new URLSearchParams();
  if (filters.status !== 'all') params.set('status', filters.status);
  if (filters.sort !== 'newest') params.set('sort', filters.sort);
  const query = params.toString();
  return `${basePath}${query ? `?${query}` : ''}`;
}

export function wikiDiscussionStatusLabel(status) {
  if (status === 'open') return '열림';
  if (status === 'paused') return '일시 중지';
  if (status === 'closed') return '닫힘';
  return '상태 확인 필요';
}

export function wikiDiscussionStatusClass(status) {
  if (status === 'open') return 'chip-accent';
  if (status === 'paused') return 'border-amber-300/30 bg-amber-300/10 text-amber-100';
  return 'chip-muted';
}

export function wikiDiscussionMatchesStatusFilter(status, filter) {
  if (filter === 'all') return status !== 'deleted';
  if (filter === 'active') return status === 'open' || status === 'paused';
  return status === filter;
}

export function countWikiDiscussionStatuses(items) {
  const counts = { total: 0, open: 0, paused: 0, closed: 0 };
  for (const item of items) {
    if (!item || item.status === 'deleted') continue;
    counts.total += 1;
    if (item.status === 'open' || item.status === 'paused' || item.status === 'closed') {
      counts[item.status] += 1;
    }
  }
  return counts;
}

export function wikiDiscussionFilterCount(counts, filter) {
  if (filter === 'all') return counts.total;
  if (filter === 'active') return counts.open + counts.paused;
  return counts[filter] ?? 0;
}
