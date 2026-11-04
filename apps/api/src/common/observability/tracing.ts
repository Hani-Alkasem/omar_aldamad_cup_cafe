/**
 * OpenTelemetry tracing, opt-in: set OTEL_EXPORTER_OTLP_ENDPOINT (e.g. http://otel-collector:4318
 * or Jaeger's OTLP port) and spans for inbound HTTP, Express/Nest routes, outbound HTTP, Redis and
 * Prisma queries are exported. Must load before anything it instruments, so entrypoints import it first.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';

let sdk: NodeSDK | undefined;

export function startTracing(serviceName: string) {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT || sdk) return;
  process.env.OTEL_SERVICE_NAME ??= serviceName;
  /* eslint-disable @typescript-eslint/no-require-imports -- loaded lazily so tracing costs nothing when off */
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { PrismaInstrumentation } = require('@prisma/instrumentation');
  /* eslint-enable @typescript-eslint/no-require-imports */
  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Noise or not applicable here.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-http': { ignoreIncomingRequestHook: (req: { url?: string }) => /\/(health|metrics)$/.test(req.url ?? '') },
      }),
      new PrismaInstrumentation(),
    ],
  });
  sdk.start();
  const stop = () => void sdk?.shutdown().catch(() => undefined);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
