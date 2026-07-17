export function visibleServerWikiNavigation(items, collapsedIds) {
  const visible = [];
  let hiddenBelowDepth = null;

  for (const item of items) {
    if (hiddenBelowDepth !== null && item.depth > hiddenBelowDepth) continue;
    if (hiddenBelowDepth !== null && item.depth <= hiddenBelowDepth) hiddenBelowDepth = null;

    visible.push(item);
    if (item.hasChildren && collapsedIds.has(item.id)) hiddenBelowDepth = item.depth;
  }

  return visible;
}

export function serverWikiAncestorIds(items, currentId) {
  const currentIndex = items.findIndex((item) => item.id === currentId);
  if (currentIndex < 0) return [];

  const ancestors = [];
  let nextDepth = items[currentIndex].depth;
  for (let index = currentIndex - 1; index >= 0 && nextDepth > 0; index -= 1) {
    const candidate = items[index];
    if (candidate.depth < nextDepth) {
      ancestors.push(candidate.id);
      nextDepth = candidate.depth;
    }
  }
  return ancestors;
}

export function parseCollapsedServerWikiNavigation(value, items) {
  if (!value) return new Set();
  try {
    const allowed = new Set(items.filter((item) => item.hasChildren).map((item) => item.id));
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id) => typeof id === 'string' && allowed.has(id)));
  } catch {
    return new Set();
  }
}

export function serverWikiDocumentTitle(displayTitle, slugs, wikiName) {
  const title = displayTitle.trim();
  for (const slug of new Set(slugs.map((value) => value?.trim()).filter(Boolean))) {
    if (title === slug) return wikiName;
    if (title.startsWith(`${slug}/`)) return title.slice(slug.length + 1);
  }
  return title;
}
