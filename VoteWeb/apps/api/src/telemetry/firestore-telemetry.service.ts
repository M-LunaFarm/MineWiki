import { Injectable } from '@nestjs/common';
import { ObservabilityExporter } from '@creepervote/logger';

@Injectable()
export class FirestoreTelemetryService {
  constructor(private readonly exporter: ObservabilityExporter) {}

  async record(
    operation: string,
    collection: string,
    durationMs: number,
    success: boolean,
    error?: string
  ): Promise<void> {
    await this.exporter.report({
      source: 'api',
      type: 'firestore',
      operation,
      collection,
      success,
      durationMs,
      error,
      timestamp: new Date().toISOString()
    });
  }
}
