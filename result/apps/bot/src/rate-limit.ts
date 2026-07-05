import { DiscordAPIError, HTTPError } from 'discord.js';

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export class RateLimitQueue {
  private nextAvailableAt = 0;

  async schedule<T>(task: () => Promise<T>): Promise<T> {
    const now = Date.now();
    if (now < this.nextAvailableAt) {
      await delay(this.nextAvailableAt - now);
    }

    try {
      const result = await task();
      return result;
    } catch (error) {
      if (isRateLimitError(error)) {
        const retryAfter = extractRetryAfterMs(error);
        this.nextAvailableAt = Date.now() + retryAfter;
        await delay(retryAfter);
      }
      throw error;
    }
  }
}

export function isMissingPermissionsError(error: unknown): boolean {
  return getStatus(error) === 403;
}

export function isUnknownChannelError(error: unknown): boolean {
  return getStatus(error) === 404;
}

export function isRateLimitError(error: unknown): error is DiscordAPIError | HTTPError {
  return getStatus(error) === 429;
}

export function extractRetryAfterMs(error: unknown): number {
  const raw = (error as { rawError?: { retry_after?: number }; headers?: MapLike }).rawError
    ?.retry_after;
  if (isNumber(raw)) {
    return Math.max(500, Math.ceil(raw * 1000));
  }
  const header = (error as { headers?: MapLike }).headers?.get?.('retry-after');
  if (isNumber(header)) {
    return Math.max(500, Math.ceil(header * 1000));
  }
  if (typeof header === 'string') {
    const parsed = Number.parseFloat(header);
    if (!Number.isNaN(parsed)) {
      return Math.max(500, Math.ceil(parsed * 1000));
    }
  }
  return 1000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MapLike {
  get?(key: string): unknown;
}

function getStatus(error: unknown): number | undefined {
  if (!error) {
    return undefined;
  }
  if (error instanceof DiscordAPIError || error instanceof HTTPError) {
    return error.status;
  }
  if (typeof (error as { status?: number }).status === 'number') {
    return (error as { status?: number }).status;
  }
  return undefined;
}
