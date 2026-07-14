import { diff3Merge, mergeDiff3 } from 'node-diff3';

export interface WikiThreeWayMergeResult {
  readonly contentRaw: string;
  readonly conflictCount: number;
  readonly hasConflicts: boolean;
}

const LOCAL_LABEL = '내 편집';
const BASE_LABEL = '기준 판';
const CURRENT_LABEL = '최신 판';
const MAX_MERGE_BYTES = 1024 * 1024;
const MAX_MERGE_LINES = 20_000;

export class WikiMergeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikiMergeLimitError';
  }
}

export function mergeWikiSource(
  localContent: string,
  baseContent: string,
  currentContent: string
): WikiThreeWayMergeResult {
  const normalizedLocal = normalizeWikiSource(localContent);
  const normalizedBase = normalizeWikiSource(baseContent);
  const normalizedCurrent = normalizeWikiSource(currentContent);
  assertWikiSourceBounds(normalizedLocal);
  assertWikiSourceBounds(normalizedBase);
  assertWikiSourceBounds(normalizedCurrent);
  const localLines = lines(normalizedLocal);
  const baseLines = lines(normalizedBase);
  const currentLines = lines(normalizedCurrent);
  const regions = diff3Merge(localLines, baseLines, currentLines, {
    excludeFalseConflicts: true
  });
  const conflictCount = regions.reduce(
    (count, region) => count + (region.conflict ? 1 : 0),
    0
  );
  const merged = mergeDiff3(localLines, baseLines, currentLines, {
    excludeFalseConflicts: true,
    label: {
      a: LOCAL_LABEL,
      o: BASE_LABEL,
      b: CURRENT_LABEL
    }
  });
  const contentRaw = merged.result.join('\n');
  assertWikiSourceBounds(contentRaw);
  return {
    contentRaw,
    conflictCount,
    hasConflicts: merged.conflict || conflictCount > 0
  };
}

export function hasWikiConflictMarkers(contentRaw: string): boolean {
  return /^(?:<<<<<<< 내 편집|\|\|\|\|\|\|\| 기준 판|=======|>>>>>>> 최신 판)$/m.test(
    contentRaw.replace(/\r\n?/g, '\n')
  );
}

export function assertWikiSourceBounds(contentRaw: string): void {
  const normalized = normalizeWikiSource(contentRaw);
  if (Buffer.byteLength(normalized, 'utf8') > MAX_MERGE_BYTES) {
    throw new WikiMergeLimitError('Wiki source exceeds the merge size limit.');
  }
  if (normalized.split('\n').length > MAX_MERGE_LINES) {
    throw new WikiMergeLimitError('Wiki source exceeds the merge line limit.');
  }
}

function lines(content: string): string[] {
  return content.split('\n');
}

function normalizeWikiSource(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}
