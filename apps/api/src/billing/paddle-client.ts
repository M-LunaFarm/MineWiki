import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';

const REQUEST_TIMEOUT_MS = 10_000;

interface PaddleEnvelope {
  readonly data?: unknown;
  readonly error?: { readonly detail?: string };
  readonly meta?: {
    readonly pagination?: {
      readonly has_more?: boolean;
      readonly next?: string | null;
    };
  };
}

export interface CreatePaddleTransactionInput {
  readonly priceId: string;
  readonly checkoutIntentId: string;
  readonly checkoutUrl: string;
}

export interface PaddleTransactionResult {
  readonly transactionId: string;
  readonly checkoutUrl: string;
}

export interface PaddlePortalResult {
  readonly overviewUrl: string;
}

const TRANSACTION_RECONCILIATION_PAGE_LIMIT = 20;

@Injectable()
export class PaddleClient {
  constructor(private readonly config: ConfigService) {}

  async createTransaction(input: CreatePaddleTransactionInput): Promise<PaddleTransactionResult> {
    const envelope = await this.request('/transactions', {
      items: [{ price_id: input.priceId, quantity: 1 }],
      collection_mode: 'automatic',
      custom_data: { minewiki_checkout_intent_id: input.checkoutIntentId },
      checkout: { url: input.checkoutUrl },
    });
    const data = objectValue(envelope.data);
    const checkout = objectValue(data.checkout);
    return {
      transactionId: requiredProviderId(data.id, 'txn_', 'transaction'),
      checkoutUrl: requiredHttpsUrl(checkout.url, 'checkout'),
    };
  }

  async createPortalSession(customerId: string, subscriptionId: string): Promise<PaddlePortalResult> {
    const envelope = await this.request(`/customers/${encodeURIComponent(customerId)}/portal-sessions`, {
      subscription_ids: [subscriptionId],
    });
    const data = objectValue(envelope.data);
    const urls = objectValue(data.urls);
    const general = objectValue(urls.general);
    return { overviewUrl: requiredHttpsUrl(general.overview, 'portal') };
  }

  async findTransactionByCheckoutIntent(
    checkoutIntentId: string,
    createdAfter: Date,
  ): Promise<PaddleTransactionResult | null> {
    const params = new URLSearchParams({
      'created_at[GTE]': new Date(createdAfter.getTime() - 2 * 60_000).toISOString(),
      origin: 'api',
      order_by: 'created_at[ASC]',
      per_page: '30',
    });
    for (let page = 0; page < TRANSACTION_RECONCILIATION_PAGE_LIMIT; page += 1) {
      const envelope = await this.request(`/transactions?${params.toString()}`, undefined, 'GET');
      const matches = arrayValue(envelope.data)
        .filter((item) => objectValue(item).custom_data
          && objectValue(objectValue(item).custom_data).minewiki_checkout_intent_id === checkoutIntentId);
      if (matches.length > 1) {
        throw new BadGatewayException('Paddle returned duplicate transactions for one checkout intent.');
      }
      if (matches.length === 1) {
        const transaction = objectValue(matches[0]);
        const checkout = objectValue(transaction.checkout);
        return {
          transactionId: requiredProviderId(transaction.id, 'txn_', 'transaction'),
          checkoutUrl: requiredHttpsUrl(checkout.url, 'checkout'),
        };
      }
      const pagination = envelope.meta?.pagination;
      if (pagination?.has_more !== true) return null;
      const after = pagination.next ? new URL(pagination.next).searchParams.get('after') : null;
      if (!after || !/^txn_[a-z\d]{26}$/u.test(after)) {
        throw new BadGatewayException('Paddle transaction pagination is invalid.');
      }
      params.set('after', after);
    }
    throw new BadGatewayException('Paddle transaction reconciliation exceeded its safe scan limit.');
  }

  private async request(
    path: string,
    body?: Record<string, unknown>,
    method: 'GET' | 'POST' = 'POST',
  ): Promise<PaddleEnvelope> {
    if (this.config.get('PADDLE_MODE', 'off') !== 'live') {
      throw new ServiceUnavailableException('Paddle billing is not enabled.');
    }
    const apiKey = this.config.get('PADDLE_API_KEY');
    const baseUrl = this.config.get('PADDLE_ENV', 'sandbox') === 'production'
      ? 'https://api.paddle.com'
      : 'https://sandbox-api.paddle.com';
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Paddle-Version': '1',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new BadGatewayException('Paddle request did not complete.');
    }
    let envelope: PaddleEnvelope;
    try {
      envelope = await response.json() as PaddleEnvelope;
    } catch {
      throw new BadGatewayException('Paddle returned an invalid response.');
    }
    if (!response.ok) {
      throw new BadGatewayException(envelope.error?.detail || 'Paddle rejected the request.');
    }
    return envelope;
  }
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new BadGatewayException('Paddle response is missing required data.');
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BadGatewayException('Paddle response is missing required data.');
  }
  return value as Record<string, unknown>;
}

function requiredProviderId(value: unknown, prefix: string, label: string): string {
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length > 64) {
    throw new BadGatewayException(`Paddle ${label} identifier is invalid.`);
  }
  return value;
}

function requiredHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new BadGatewayException(`Paddle ${label} URL is invalid.`);
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') throw new Error('not https');
    return parsed.toString();
  } catch {
    throw new BadGatewayException(`Paddle ${label} URL is invalid.`);
  }
}
