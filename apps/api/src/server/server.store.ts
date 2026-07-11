export interface ServerFilters {
  readonly edition?: 'java' | 'bedrock';
  readonly tag?: string;
  readonly search?: string;
}

export type ServerSort =
  | 'votes24h_desc'
  | 'votesMonthly_desc'
  | 'reviews_desc'
  | 'latest'
  | 'name_asc';

export type StoredVerificationGrade = 'A' | 'B' | 'C' | 'Unverified';

const VERIFICATION_ORDER: StoredVerificationGrade[] = ['A', 'B', 'C', 'Unverified'];

export function isServerSort(value: unknown): value is ServerSort {
  return (
    value === 'votes24h_desc' ||
    value === 'votesMonthly_desc' ||
    value === 'reviews_desc' ||
    value === 'latest' ||
    value === 'name_asc'
  );
}

export function isEdition(value: unknown): value is ServerFilters['edition'] {
  return value === 'java' || value === 'bedrock';
}

export function downgradeGrade(current: StoredVerificationGrade): StoredVerificationGrade {
  const index = VERIFICATION_ORDER.indexOf(current);
  if (index < 0 || index === VERIFICATION_ORDER.length - 1) {
    return 'Unverified';
  }
  return VERIFICATION_ORDER[index + 1] ?? 'Unverified';
}
