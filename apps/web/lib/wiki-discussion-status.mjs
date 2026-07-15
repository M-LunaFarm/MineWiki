export const WIKI_DISCUSSION_STATUS_FILTERS = Object.freeze([
  { value: 'all', label: '전체' },
  { value: 'active', label: '진행 중' },
  { value: 'open', label: '열림' },
  { value: 'paused', label: '일시 중지' },
  { value: 'closed', label: '닫힘' },
]);

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
