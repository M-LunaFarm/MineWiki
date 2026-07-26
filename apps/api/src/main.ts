import { Logger, ObservabilityExporter } from '@minewiki/logger';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { ConfigService } from '@minewiki/config';
import * as Sentry from '@sentry/node';
import { TelemetryInterceptor } from './telemetry/telemetry.interceptor';
import { randomUUID } from 'node:crypto';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { runInHttpRequestContext } from './common/http/request-context';
import { isLoopbackIp } from './common/http/client-ip';
import { API_JSON_BODY_LIMIT_BYTES } from './common/http/body-limits';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: API_JSON_BODY_LIMIT_BYTES,
      logger: false,
      trustProxy: (address) => isLoopbackIp(address),
    }),
    {
      bufferLogs: true,
      rawBody: true
    }
  );

  const config = new ConfigService();
  const port = config.getNumber('API_PORT', 3000);
  const host = config.get('API_HOST', '0.0.0.0');

  const sentryDsn = config.getOptional('SENTRY_DSN');
  const exporter = app.get(ObservabilityExporter);

  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, environment: config.get('NODE_ENV', 'development') });
    Sentry.addEventProcessor((event) => {
      void exporter.report({
        source: 'api',
        type: 'sentry',
        level: event.level,
        message: event.message,
        exception: event.exception?.values?.[0]?.value,
        timestamp: new Date().toISOString()
      });
      return event;
    });
  }

  app.getHttpAdapter().getInstance().addHook('onRequest', (request, reply, done) => {
    const requestIdHeader = request.headers['x-request-id'];
    const requestId = Array.isArray(requestIdHeader)
      ? requestIdHeader[0]
      : requestIdHeader || randomUUID();
    request.requestId = requestId;
    reply.header('x-request-id', requestId);
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), geolocation=(), microphone=(), usb=()');
    done();
  });
  app.getHttpAdapter().getInstance().addHook('onRequest', runInHttpRequestContext);

  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(app.get(TelemetryInterceptor));
  app.enableShutdownHooks();
  await app.listen({ port, host });
  if (typeof process.send === 'function') {
    process.send('ready');
  }
  Logger.info({ port, host }, 'API server listening');
}

bootstrap().catch((error) => {
  Logger.error({ err: error }, 'API bootstrap failed');
  process.exitCode = 1;
});
