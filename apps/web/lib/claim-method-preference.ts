import {
  SUPPORTED_CLAIM_METHODS,
  type ClaimMethod,
} from '@minewiki/schemas/claim-methods';

export type ClaimMethodPreference = ClaimMethod;

const CLAIM_SELECTED_METHOD_KEY_PREFIX = 'minewiki_claim_selected_method';

function storageKey(accountId: string, serverId: string): string {
  return `${CLAIM_SELECTED_METHOD_KEY_PREFIX}:${accountId}:${serverId}`;
}

export function loadClaimMethodPreference(
  accountId: string,
  serverId: string,
): ClaimMethod | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(storageKey(accountId, serverId));
    return SUPPORTED_CLAIM_METHODS.find((method) => method === value) ?? null;
  } catch {
    return null;
  }
}

export function persistClaimMethodPreference(
  accountId: string,
  serverId: string,
  method: ClaimMethod,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(accountId, serverId), method);
  } catch {
    // Method selection continuity is optional when browser storage is unavailable.
  }
}
