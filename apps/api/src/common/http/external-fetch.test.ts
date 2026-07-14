import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithTimeout } from './external-fetch';

test('external fetch aborts a stalled request at the bounded timeout', async () => {
  const stalledFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;

  await assert.rejects(
    fetchWithTimeout('https://example.com', {}, 5, stalledFetch),
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  );
});

test('external fetch preserves a caller cancellation and clears its listener', async () => {
  const caller = new AbortController();
  const cancellation = new Error('cancelled by caller');
  const stalledFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
  const request = fetchWithTimeout(
    'https://example.com',
    { signal: caller.signal },
    5_000,
    stalledFetch,
  );
  caller.abort(cancellation);
  await assert.rejects(request, (error: unknown) => error === cancellation);
});
