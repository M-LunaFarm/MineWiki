function toCount(value) {
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function readServerWikiPublicationCoverage(row = {}) {
  const activeCanonical = toCount(row.activeCanonical ?? row.active_canonical);
  const published = toCount(row.published);
  const neverReleased = toCount(row.neverReleased ?? row.never_released);
  return {
    activeCanonical,
    published,
    neverReleased,
    previouslyReleased: Math.max(0, activeCanonical - neverReleased),
  };
}

export function describeServerWikiPublicationCoverage(coverage) {
  if (coverage.activeCanonical === 0) {
    return 'no active owner-managed canonical server wikis';
  }
  return `${coverage.activeCanonical} active owner-managed canonical server wikis; `
    + `${coverage.published} published; ${coverage.neverReleased} never released`;
}
