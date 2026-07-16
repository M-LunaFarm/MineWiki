export interface BillingEntitlementSweepResult {
  readonly examined: number;
  readonly expired: number;
  readonly downgraded: number;
  readonly skipped: number;
  readonly failed: number;
}

export async function triggerBillingEntitlementSweep(input: {
  readonly apiBaseUrl: string;
  readonly internalToken: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<BillingEntitlementSweepResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${input.apiBaseUrl.replace(/\/$/u, '')}/v1/internal/billing/reconcile-entitlements`, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.internalToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Billing entitlement sweep failed with HTTP ${response.status}`);
  return await response.json() as BillingEntitlementSweepResult;
}
