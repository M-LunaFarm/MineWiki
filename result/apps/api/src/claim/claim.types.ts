export type ClaimMethod = 'plugin' | 'dns' | 'motd';

export type ClaimMethodState = 'pending' | 'verified' | 'expired' | 'failed';

export interface ClaimMethodStatus {
  readonly method: ClaimMethod;
  readonly token: string;
  readonly issuedAt: string;
  readonly status: ClaimMethodState;
  readonly verified: boolean;
  readonly verifiedAt?: string;
  readonly expiresAt?: string;
  readonly lastCheckedAt?: string;
  readonly note?: string;
}

export interface ClaimStatusResponse {
  readonly serverId: string;
  readonly grade: 'Verified' | 'Unverified';
  readonly methods: ClaimMethodStatus[];
}
