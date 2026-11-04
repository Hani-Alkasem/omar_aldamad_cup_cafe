import { createServer, type Server } from 'node:http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

/** Opt-in OTLP tracing (OTEL_EXPORTER_OTLP_ENDPOINT): HTTP to the API, Redis, outbound fetch. */
export function startTracing() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  process.env.OTEL_SERVICE_NAME ??= 'itam-discovery-worker';
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false }, '@opentelemetry/instrumentation-dns': { enabled: false }, '@opentelemetry/instrumentation-net': { enabled: false } })],
  });
  sdk.start();
  process.once('SIGTERM', () => void sdk.shutdown().catch(() => undefined));
}

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'itam_worker_' });
export const runsTotal = new Counter({ name: 'itam_worker_runs_total', help: 'Runs executed by this worker', labelNames: ['protocol', 'status'], registers: [registry] });
export const runSeconds = new Histogram({ name: 'itam_worker_run_seconds', help: 'Run duration', labelNames: ['protocol'], buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600], registers: [registry] });
export const hostsTotal = new Counter({ name: 'itam_worker_hosts_total', help: 'Hosts answered vs probed', labelNames: ['protocol', 'result'], registers: [registry] });

/** Prometheus scrape endpoint (the worker has no other HTTP surface). */
export function serveMetrics(port = Number(process.env.METRICS_PORT ?? 9465)): Server {
  return createServer(async (req, res) => {
    if (req.url !== '/metrics') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': registry.contentType }).end(await registry.metrics());
  }).listen(port);
}
