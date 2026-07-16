const DRAFT_VERSION = 1;
const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DRAFT_MAX_CONTENT_BYTES = 1024 * 1024;
const DRAFT_MAX_SUMMARY_LENGTH = 500;

export function buildWikiEditorDraftKey({ accountId, routePath, sectionAnchor = '' }) {
  return `minewiki:wiki-draft:v${DRAFT_VERSION}:${encodeURIComponent(String(accountId))}:${encodeURIComponent(String(routePath))}:${encodeURIComponent(String(sectionAnchor))}`;
}

export function readWikiEditorDraft(storage, key, context, now = Date.now()) {
  let raw;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const draft = JSON.parse(raw);
    if (
      draft?.version !== DRAFT_VERSION ||
      draft.accountId !== String(context.accountId) ||
      draft.routePath !== String(context.routePath) ||
      draft.sectionAnchor !== String(context.sectionAnchor ?? '') ||
      typeof draft.contentRaw !== 'string' ||
      typeof draft.editSummary !== 'string' ||
      typeof draft.isMinor !== 'boolean' ||
      !Number.isSafeInteger(draft.savedAt) ||
      draft.savedAt <= 0 ||
      now - draft.savedAt > DRAFT_MAX_AGE_MS ||
      draft.editSummary.length > DRAFT_MAX_SUMMARY_LENGTH ||
      new TextEncoder().encode(draft.contentRaw).byteLength > DRAFT_MAX_CONTENT_BYTES
    ) {
      removeWikiEditorDraft(storage, key);
      return null;
    }
    return draft;
  } catch {
    removeWikiEditorDraft(storage, key);
    return null;
  }
}

export function writeWikiEditorDraft(storage, key, context, value, now = Date.now()) {
  const contentRaw = String(value.contentRaw ?? '');
  const editSummary = String(value.editSummary ?? '').slice(0, DRAFT_MAX_SUMMARY_LENGTH);
  if (new TextEncoder().encode(contentRaw).byteLength > DRAFT_MAX_CONTENT_BYTES) return false;
  try {
    storage.setItem(key, JSON.stringify({
      version: DRAFT_VERSION,
      accountId: String(context.accountId),
      routePath: String(context.routePath),
      sectionAnchor: String(context.sectionAnchor ?? ''),
      baseRevisionId: value.baseRevisionId ? String(value.baseRevisionId) : null,
      contentRaw,
      editSummary,
      isMinor: Boolean(value.isMinor),
      savedAt: now
    }));
    return true;
  } catch {
    return false;
  }
}

export function removeWikiEditorDraft(storage, key) {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
