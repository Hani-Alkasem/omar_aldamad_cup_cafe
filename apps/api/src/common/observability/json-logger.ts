import { trace } from '@opentelemetry/api';
import type { LoggerService } from '@nestjs/common';
import { requestContext } from './context';

type Level = 'error' | 'warn' | 'info' | 'debug' | 'verbose';
const ORDER: Level[] = ['error', 'warn', 'info', 'debug', 'verbose'];

/**
 * One JSON object per line, for Loki/ELK/Splunk: time, level, message, Nest context, and the
 * request and trace ids that tie a log line to an HTTP request and its OpenTelemetry trace.
 * LOG_FORMAT=json enables it (the default in the container images); LOG_LEVEL filters.
 */
export class JsonLogger implements LoggerService {
  private readonly max = ORDER.indexOf((process.env.LOG_LEVEL as Level) ?? 'info');

  private write(level: Level, message: unknown, context?: string, extra?: Record<string, unknown>) {
    if (ORDER.indexOf(level) > (this.max < 0 ? 2 : this.max)) return;
    const span = trace.getActiveSpan()?.spanContext();
    const line: Record<string, unknown> = {
      t: new Date().toISOString(),
      level,
      msg: message instanceof Error ? message.message : typeof message === 'string' ? message : JSON.stringify(message),
      ...(context ? { context } : {}),
      ...(requestContext.getStore() ? { requestId: requestContext.getStore()!.requestId } : {}),
      ...(span ? { traceId: span.traceId, spanId: span.spanId } : {}),
      ...extra,
    };
    (level === 'error' ? process.stderr : process.stdout).write(`${JSON.stringify(line)}\n`);
  }

  log(message: unknown, context?: string) {
    this.write('info', message, context);
  }
  error(message: unknown, stack?: string, context?: string) {
    this.write('error', message, context, stack ? { stack } : undefined);
  }
  warn(message: unknown, context?: string) {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string) {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string) {
    this.write('verbose', message, context);
  }
  /** Structured access log entry. */
  http(fields: Record<string, unknown>) {
    this.write('info', 'http', 'HTTP', fields);
  }
}

export const useJsonLogs = () => (process.env.LOG_FORMAT ?? '') === 'json';
