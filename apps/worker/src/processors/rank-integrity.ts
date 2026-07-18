export type PersistedRankState = {
  readonly rankBest: number;
  readonly rankCalculatedAt: Date | null;
} | null;

export function isRankEligible(votesTotal: number): boolean {
  return Number.isSafeInteger(votesTotal) && votesTotal > 0;
}

export function resolveRankBest(input: {
  readonly currentRank: number;
  readonly snapshotBest?: number;
  readonly persisted: PersistedRankState;
}): number {
  const candidates = [input.currentRank];
  if (input.snapshotBest && input.snapshotBest > 0) {
    candidates.push(input.snapshotBest);
  }
  if (
    input.persisted?.rankCalculatedAt &&
    Number.isSafeInteger(input.persisted.rankBest) &&
    input.persisted.rankBest > 0
  ) {
    candidates.push(input.persisted.rankBest);
  }
  return Math.min(...candidates);
}
