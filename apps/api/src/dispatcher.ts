import { startTracing } from './common/observability/tracing';
startTracing('itam-dispatcher');

import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { JsonLogger, useJsonLogs } from './common/observability/json-logger';
import { registry } from './common/observability/metrics';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaModule } from './common/prisma.module';
import { DispatcherModule } from './modules/integrations/integrations.module';
import { DispatcherService } from './modules/integrations/dispatcher.service';

@Module({ imports: [PrismaModule, DispatcherModule] })
class DispatcherRoot {}

/** Separate process (same image as the API): node dist/dispatcher.js. Scale it horizontally. */
async function main() {
  const ctx = await NestFactory.createApplicationContext(DispatcherRoot, { logger: useJsonLogs() ? new JsonLogger() : ['log', 'warn', 'error'] });
  // Prometheus scrape target (no HTTP API in this process otherwise).
  const metricsPort = Number(process.env.METRICS_PORT ?? 9464);
  const metrics = createServer(async (req, res) => {
    if (req.url !== '/metrics') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': registry.contentType }).end(await registry.metrics());
  }).listen(metricsPort);
  ctx.enableShutdownHooks();
  const dispatcher = ctx.get(DispatcherService);
  // Container health check: the file's mtime proves the loop is turning.
  const beatFile = process.env.DISPATCHER_HEARTBEAT_FILE ?? '/tmp/dispatcher.alive';
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => dispatcher.stop());
  await dispatcher.run(() => writeFileSync(beatFile, String(Date.now())));
  metrics.close();
  await ctx.close();
}

void main();
