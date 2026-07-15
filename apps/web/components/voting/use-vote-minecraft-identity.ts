'use client';

import { useEffect, useState } from 'react';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';

export interface VoteMinecraftIdentity {
  readonly playerName: string | null;
}

export interface VoteEligibility {
  readonly eligible: boolean;
  readonly reason: 'eligible' | 'cooldown' | 'ownership_required' | 'identity_conflict';
  readonly requiresOwnership: boolean;
  readonly identityStatus: 'verified' | 'unverified' | 'conflict';
  readonly playerName: string | null;
  readonly nextEligibleAt: string | null;
}

export type VoteIdentityStatus = 'idle' | 'loading' | 'verified' | 'unverified' | 'conflict' | 'guest' | 'error';

export function useVoteMinecraftIdentity(open: boolean, serverId: string, apiBaseUrl?: string) {
  const [status, setStatus] = useState<VoteIdentityStatus>('idle');
  const [identity, setIdentity] = useState<VoteMinecraftIdentity | null>(null);
  const [eligibility, setEligibility] = useState<VoteEligibility | null>(null);
  const baseUrl = normalizeApiBaseUrl(apiBaseUrl);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setStatus('loading');
    setIdentity(null);
    setEligibility(null);

    void fetch(`${baseUrl}/v1/servers/${serverId}/votes/eligibility`, {
      credentials: 'include',
      signal: controller.signal,
    }).then(async (response) => {
      if (response.ok) {
        const nextEligibility = (await response.json()) as VoteEligibility;
        setEligibility(nextEligibility);
        setIdentity({ playerName: nextEligibility.playerName });
        setStatus(nextEligibility.identityStatus === 'conflict' ? 'conflict' : nextEligibility.identityStatus);
        return;
      }
      setStatus(response.status === 401 ? 'guest' : response.status === 404 ? 'unverified' : 'error');
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setStatus('error');
    });

    return () => controller.abort();
  }, [baseUrl, open, serverId]);

  return { identity, eligibility, status } as const;
}
