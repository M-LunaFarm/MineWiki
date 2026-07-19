export interface PaddleWebhookInboxSweepResult {
  readonly examined: number;
  readonly processed: number;
  readonly ignored: number;
  readonly stale: number;
  readonly quarantined: number;
  readonly retried: number;
  readonly deadLettered: number;
  readonly skipped: number;
}

export async function triggerPaddleWebhookInboxSweep(input: {
  readonly apiBaseUrl: string;
  readonly internalToken: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<PaddleWebhookInboxSweepResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${input.apiBaseUrl.replace(/\/$/u, '')}/v1/internal/billing/paddle/process-due`, {
    method: 'POST',
    headers: { authorization: `Bearer ${input.internalToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Paddle webhook inbox sweep failed with HTTP ${response.status}`);
  return await response.json() as PaddleWebhookInboxSweepResult;
}
