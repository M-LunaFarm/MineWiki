export interface AccountDeletionSweepResult {
  readonly processed: number;
  readonly blocked: number;
  readonly failed: number;
}

export async function triggerAccountDeletionSweep(input: {
  readonly apiBaseUrl: string;
  readonly internalToken: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<AccountDeletionSweepResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${input.apiBaseUrl.replace(/\/$/u, '')}/v1/internal/account-deletions/process-due`, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.internalToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Account deletion sweep failed with HTTP ${response.status}`);
  return await response.json() as AccountDeletionSweepResult;
}
