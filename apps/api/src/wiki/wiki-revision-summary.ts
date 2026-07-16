export interface WikiRevisionEditSummaryState {
  readonly editSummary: string | null;
  readonly editSummaryHidden?: boolean | null;
}

export interface PublicWikiRevisionEditSummary {
  readonly editSummary: string | null;
  readonly editSummaryHidden: boolean;
}

export function publicWikiRevisionEditSummary(
  revision: WikiRevisionEditSummaryState
): PublicWikiRevisionEditSummary {
  const hidden = revision.editSummaryHidden === true;
  return {
    editSummary: hidden ? null : revision.editSummary,
    editSummaryHidden: hidden
  };
}

export function publicWikiRecentChangeSummary(input: {
  readonly summary: string | null;
  readonly revisionId: bigint | null;
  readonly hiddenByRevisionId: ReadonlyMap<bigint, boolean>;
}): { readonly summary: string | null; readonly summaryHidden: boolean } {
  if (input.revisionId === null) {
    return { summary: input.summary, summaryHidden: false };
  }

  // A denormalized recent-change summary is safe to expose only when its
  // source revision was loaded and explicitly says the summary is public.
  // Missing source rows therefore fail closed instead of reviving stale text.
  if (input.hiddenByRevisionId.get(input.revisionId) !== false) {
    return { summary: null, summaryHidden: true };
  }
  return { summary: input.summary, summaryHidden: false };
}
