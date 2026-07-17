import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';

const REQUEST_TIMEOUT_MS = 10_000;

interface PaddleEnvelope {
  readonly data?: unknown;
  readonly error?: { readonly detail?: string };
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

  private async request(path: string, body: Record<string, unknown>): Promise<PaddleEnvelope> {
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
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
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
