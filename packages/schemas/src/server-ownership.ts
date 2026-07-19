export const SERVER_OWNERSHIP_CHALLENGE_FAILURE_LIMIT = 3;
export const SERVER_OWNERSHIP_CHALLENGE_FAILURE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const SERVER_OWNERSHIP_CHALLENGE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export type ServerOwnershipProofResult = 'verified' | 'confirmed_absent' | 'inconclusive';

export interface ServerOwnershipVerificationState {
  readonly ownerAccountId?: string | null;
  readonly ownershipVerificationFailures?: number | null;
  readonly ownershipChallengeStartedAt?: Date | null;
  readonly ownershipChallengeExpiresAt?: Date | null;
  readonly ownershipChallengeSuspendedAt?: Date | null;
  readonly ownershipLastFailureAt?: Date | null;
}

export interface ServerOwnershipVerificationTransition {
  readonly ownershipVerificationFailures: number;
  readonly ownershipChallengeStartedAt: Date | null;
  readonly ownershipChallengeExpiresAt: Date | null;
  readonly ownershipLastFailureAt: Date | null;
  readonly challengeMatured: boolean;
}

export function isServerOwnershipChallengeMatured(
  state: ServerOwnershipVerificationState,
  at: Date = new Date(),
): boolean {
  return Boolean(
    state.ownerAccountId
      && (state.ownershipVerificationFailures ?? 0) >= SERVER_OWNERSHIP_CHALLENGE_FAILURE_LIMIT
      && state.ownershipChallengeExpiresAt
      && state.ownershipChallengeExpiresAt.getTime() <= at.getTime(),
  );
}

export function isServerOwnershipManagementSuspended(
  state: ServerOwnershipVerificationState,
): boolean {
  return Boolean(state.ownerAccountId && state.ownershipChallengeSuspendedAt);
}

export function serverOwnershipVerificationTransition(
  state: ServerOwnershipVerificationState,
  result: ServerOwnershipProofResult,
  checkedAt: Date,
): ServerOwnershipVerificationTransition {
  if (result === 'verified' || !state.ownerAccountId) {
    return {
      ownershipVerificationFailures: 0,
      ownershipChallengeStartedAt: null,
      ownershipChallengeExpiresAt: null,
      ownershipLastFailureAt: null,
      challengeMatured: false,
    };
  }

  if (result === 'inconclusive'
    || (state.ownershipLastFailureAt
      && checkedAt.getTime() - state.ownershipLastFailureAt.getTime()
        < SERVER_OWNERSHIP_CHALLENGE_FAILURE_INTERVAL_MS)) {
    return {
      ownershipVerificationFailures: Math.max(0, state.ownershipVerificationFailures ?? 0),
      ownershipChallengeStartedAt: state.ownershipChallengeStartedAt ?? null,
      ownershipChallengeExpiresAt: state.ownershipChallengeExpiresAt ?? null,
      ownershipLastFailureAt: state.ownershipLastFailureAt ?? null,
      challengeMatured: false,
    };
  }

  const failures = Math.max(0, state.ownershipVerificationFailures ?? 0) + 1;
  const startsChallenge = failures >= SERVER_OWNERSHIP_CHALLENGE_FAILURE_LIMIT;
  const startedAt = state.ownershipChallengeStartedAt ?? (startsChallenge ? checkedAt : null);
  const expiresAt = state.ownershipChallengeExpiresAt
    ?? (startedAt ? new Date(startedAt.getTime() + SERVER_OWNERSHIP_CHALLENGE_GRACE_MS) : null);
  return {
    ownershipVerificationFailures: failures,
    ownershipChallengeStartedAt: startedAt,
    ownershipChallengeExpiresAt: expiresAt,
    ownershipLastFailureAt: checkedAt,
    challengeMatured:
      failures >= SERVER_OWNERSHIP_CHALLENGE_FAILURE_LIMIT
      && Boolean(expiresAt && expiresAt.getTime() <= checkedAt.getTime()),
  };
}

export function classifyServerOwnershipProofResult(input: {
  readonly status: string;
  readonly note?: string | null;
}): ServerOwnershipProofResult {
  if (input.status === 'verified') return 'verified';
  if (input.status === 'failed'
    && (input.note === 'dns_token_not_found' || input.note === 'motd_token_not_found')) {
    return 'confirmed_absent';
  }
  return 'inconclusive';
}
