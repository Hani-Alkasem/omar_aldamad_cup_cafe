import { timingSafeEqual } from 'node:crypto';
import { Controller, Get, Global, Header, HttpException, HttpStatus, Injectable, Module, Req, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { finalize, type Observable } from 'rxjs';
import { Public } from '../../modules/auth/decorators';
import { PrismaService } from '../prisma.service';
import { JsonLogger, useJsonLogs } from './json-logger';

const accessLog = useJsonLogs() && process.env.LOG_HTTP !== 'false' ? new JsonLogger() : null;

/** One registry per process: Prometheus scrapes each replica separately. */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'itam_' });

export const httpDuration = new Histogram({
  name: 'itam_http_request_duration_seconds',
  help: 'API request latency by route template (not raw path, to keep cardinality bounded)',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});
export const discoveryRuns = new Counter({ name: 'itam_discovery_runs_total', help: 'Discovery runs finished, by protocol and status', labelNames: ['protocol', 'status'], registers: [registry] });
export const discoveryHosts = new Counter({ name: 'itam_discovery_hosts_total', help: 'Hosts reconciled, by outcome', labelNames: ['outcome'], registers: [registry] });
export const webhookDeliveries = new Counter({ name: 'itam_webhook_deliveries_total', help: 'Webhook delivery attempts, by kind and result', labelNames: ['kind', 'status'], registers: [registry] });
export const webhookLatency = new Histogram({ name: 'itam_webhook_delivery_seconds', help: 'Time to deliver a webhook', labelNames: ['kind'], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers: [registry] });
export const sseClients = new Gauge({ name: 'itam_sse_clients', help: 'Browsers connected to the live event stream', registers: [registry] });

/** Request latency by route template; health and metrics themselves are skipped. */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const end = httpDuration.startTimer();
    const started = process.hrtime.bigint();
    return next.handle().pipe(
      finalize(() => {
        const route = (req.route?.path as string | undefined) ?? 'unmatched';
        if (/\/(health|metrics)$/.test(route)) return;
        end({ method: req.method, route, status: String(res.statusCode) });
        // Access log: route template, not the raw URL, so ids and search terms stay out of logs.
        if (accessLog) {
          accessLog.http({ method: req.method, route, status: res.statusCode, ms: Number(process.hrtime.bigint() - started) / 1e6, userId: (req as Request & { user?: { id: string } }).user?.id });
        }
      }),
    );
  }
}

@Injectable()
export class BacklogGauges {
  constructor(prisma: PrismaService) {
    // Gauges computed at scrape time from the database (shared truth across replicas).
    new Gauge({
      name: 'itam_webhook_backlog',
      help: 'Webhook deliveries waiting or retrying',
      labelNames: ['status'],
      registers: [registry],
      async collect() {
        const rows = await prisma.$queryRaw<Array<{ status: string; n: bigint }>>`SELECT status::text, count(*) AS n FROM webhook_deliveries WHERE status IN ('pending', 'failed') GROUP BY status`.catch(() => []);
        this.reset();
        for (const s of ['pending', 'failed']) this.set({ status: s }, Number(rows.find((r) => r.status === s)?.n ?? 0));
      },
    });
    new Gauge({
      name: 'itam_discovery_active_runs',
      help: 'Discovery runs queued or running',
      labelNames: ['status'],
      registers: [registry],
      async collect() {
        const rows = await prisma.$queryRaw<Array<{ status: string; n: bigint }>>`SELECT status::text, count(*) AS n FROM discovery_runs WHERE status IN ('queued', 'running') GROUP BY status`.catch(() => []);
        this.reset();
        for (const s of ['queued', 'running']) this.set({ status: s }, Number(rows.find((r) => r.status === s)?.n ?? 0));
      },
    });
  }
}

/**
 * GET /api/v1/metrics for Prometheus. Open by default on the internal network; set METRICS_TOKEN
 * to require "Authorization: Bearer <token>" (the API port is usually published).
 */
@ApiExcludeController()
@Controller()
export class MetricsController {
  @Get('metrics')
  @Public()
  @Header('cache-control', 'no-store')
  async metrics(@Req() req: Request): Promise<string> {
    const expected = process.env.METRICS_TOKEN;
    if (expected) {
      const given = Buffer.from(/^Bearer (.+)$/.exec(req.header('authorization') ?? '')?.[1] ?? '');
      const want = Buffer.from(expected);
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpException({ code: 'UNAUTHENTICATED', message: 'metrics token required' }, HttpStatus.UNAUTHORIZED);
    }
    req.res?.setHeader('content-type', registry.contentType);
    return registry.metrics();
  }
}

@Global()
@Module({ controllers: [MetricsController], providers: [BacklogGauges] })
export class MetricsModule {}
