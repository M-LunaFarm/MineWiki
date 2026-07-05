import { Module } from '@nestjs/common';
import { ObservabilityExporter } from '@creepervote/logger';
import { TelemetryInterceptor } from './telemetry.interceptor';
import { FirestoreTelemetryService } from './firestore-telemetry.service';

@Module({
  providers: [
    {
      provide: ObservabilityExporter,
      useFactory: () =>
        new ObservabilityExporter({
          endpoint: process.env.OBSERVABILITY_ENDPOINT,
          apiKey: process.env.OBSERVABILITY_API_KEY,
          source: 'api'
        })
    },
    TelemetryInterceptor,
    FirestoreTelemetryService
  ],
  exports: [TelemetryInterceptor, FirestoreTelemetryService, ObservabilityExporter]
})
export class TelemetryModule {}
