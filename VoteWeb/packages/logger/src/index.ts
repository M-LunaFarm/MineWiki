import pino from 'pino';

export const Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname'
          }
        }
});

export type LoggerInstance = typeof Logger;

export {
  ObservabilityExporter,
  type ObservabilityEvent,
  type ObservabilityExporterOptions
} from './observability';
