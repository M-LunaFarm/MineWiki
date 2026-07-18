export type AccountMergeStatus = 'pending' | 'completed' | 'rejected' | 'failed';

export interface AccountMergeConflict {
  readonly id: string;
  readonly kind: string;
  readonly message: string;
  readonly minecraftUuid: string | null;
  readonly discordUserId: string | null;
  readonly conflictingAccountId: string | null;
  readonly legacyWikiProfileId: string | null;
}

export interface AccountMergeAdminItem {
  readonly id: string;
  readonly ticketId: string;
  readonly requesterAccountId: string;
  readonly sourceCanonicalAccountId: string;
  readonly targetCanonicalAccountId: string | null;
  readonly candidateTargetAccountIds: string[];
  readonly conflicts: AccountMergeConflict[];
  readonly conflictFingerprint: string;
  readonly proofSummary: unknown;
  readonly status: AccountMergeStatus;
  readonly version: number;
  readonly decidedByAccountId: string | null;
  readonly decisionReason: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
