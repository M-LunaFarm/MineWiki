import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor
} from '@nestjs/common';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import * as Sentry from '@sentry/node';
import type { Observable } from 'rxjs';
import { catchError, finalize } from 'rxjs/operators';
import { ObservabilityExporter } from '@creepervote/logger';

@Injectable()
export class TelemetryInterceptor implements NestInterceptor {
  private readonly tracer = trace.getTracer('creepervote-api');

  constructor(private readonly exporter: ObservabilityExporter) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spanName = `${context.getClass().name}.${String(context.getHandler().name)}`;
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest();
    const startedAt = Date.now();

    const span = this.tracer.startSpan(spanName, {
      attributes: {
        'http.method': request?.method,
        'http.route': request?.route?.path,
        'component': context.getType()
      }
    });

    return next.handle().pipe(
      catchError((error) => {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error?.message });
        if (Sentry.getCurrentHub().getClient()) {
          Sentry.captureException(error);
        }
        throw error;
      }),
      finalize(() => {
        if (request?.res?.statusCode) {
          span.setAttribute('http.status_code', request.res.statusCode);
        }
        span.end();
        const durationMs = Date.now() - startedAt;
        void this.exporter.report({
          source: 'api',
          type: 'http',
          name: spanName,
          durationMs,
          statusCode: request?.res?.statusCode ?? 0,
          attributes: {
            route: request?.route?.path,
            method: request?.method,
            url: request?.url
          },
          timestamp: new Date().toISOString()
        });
      })
    );
  }
}
