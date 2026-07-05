import { Logger } from './index';

export type ObservabilityEvent =
  | {
      readonly source: 'api' | 'worker';
      readonly type: 'http';
      readonly name: string;
      readonly durationMs: number;
      readonly statusCode: number;
      readonly attributes?: Record<string, unknown>;
      readonly timestamp: string;
    }
  | {
      readonly source: 'worker';
      readonly type: 'queue';
      readonly queue: string;
      readonly jobId: string;
      readonly jobName?: string;
      readonly status: 'completed' | 'failed';
      readonly durationMs: number;
      readonly attempts: number;
      readonly error?: string;
      readonly timestamp: string;
    }
  | {
      readonly source: 'api';
      readonly type: 'firestore';
      readonly operation: string;
      readonly collection?: string;
      readonly success: boolean;
      readonly durationMs: number;
      readonly error?: string;
      readonly timestamp: string;
    }
  | {
      readonly source: 'api' | 'worker';
      readonly type: 'sentry';
      readonly level?: string;
      readonly message?: string;
      readonly exception?: string;
      readonly timestamp: string;
    };

export interface ObservabilityExporterOptions {
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly enabled?: boolean;
  readonly source?: 'api' | 'worker';
}

export class ObservabilityExporter {
  private readonly endpoint?: string;
  private readonly apiKey?: string;
  private readonly enabled: boolean;
  private readonly source: 'api' | 'worker';

  constructor(options: ObservabilityExporterOptions = {}) {
    this.endpoint = options.endpoint;
    this.apiKey = options.apiKey;
    this.enabled = options.enabled ?? Boolean(options.endpoint);
    this.source = options.source ?? 'api';
  }

  async report(event: ObservabilityEvent): Promise<void> {
    if (!this.enabled || !this.endpoint) {
      Logger.debug({ event }, 'Observability exporter disabled or endpoint missing');
      return;
    }

    const payload = (() => {
      switch (event.type) {
        case 'queue':
          return {
            ...event,
            source: 'worker' as const
          };
        case 'firestore':
          return {
            ...event,
            source: 'api' as const
          };
        default:
          return {
            ...event,
            source: (event.source ?? this.source) as 'api' | 'worker'
          };
      }
    })() satisfies ObservabilityEvent;

    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      Logger.warn({ err: error }, 'Failed to export observability event');
    }
  }
}
