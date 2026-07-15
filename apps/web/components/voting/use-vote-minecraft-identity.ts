'use client';

import { useEffect, useState } from 'react';
import { normalizeApiBaseUrl } from '../../lib/runtime-config';

export interface VoteMinecraftIdentity {
  readonly uuid: string;
  readonly playerName?: string;
  readonly msOwned: boolean;
}

export type VoteIdentityStatus = 'idle' | 'loading' | 'verified' | 'unverified' | 'guest' | 'error';

export function useVoteMinecraftIdentity(open: boolean, apiBaseUrl?: string) {
  const [status, setStatus] = useState<VoteIdentityStatus>('idle');
  const [identity, setIdentity] = useState<VoteMinecraftIdentity | null>(null);
  const baseUrl = normalizeApiBaseUrl(apiBaseUrl);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setStatus('loading');
    setIdentity(null);

    void fetch(`${baseUrl}/v1/minecraft/identity`, {
      credentials: 'include',
      signal: controller.signal,
    }).then(async (response) => {
      if (response.ok) {
        const nextIdentity = (await response.json()) as VoteMinecraftIdentity;
        if (!nextIdentity.msOwned || !nextIdentity.playerName) {
          setStatus('unverified');
          return;
        }
        setIdentity(nextIdentity);
        setStatus('verified');
        return;
      }
      setStatus(response.status === 401 ? 'guest' : response.status === 404 ? 'unverified' : 'error');
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setStatus('error');
    });

    return () => controller.abort();
  }, [baseUrl, open]);

  return { identity, status } as const;
}
