import { startTracing } from './common/observability/tracing';
startTracing('itam-api'); // before anything it instruments is loaded

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { JsonLogger, useJsonLogs } from './common/observability/json-logger';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';

async function main() {
  const app = configureApp(await NestFactory.create(AppModule, useJsonLogs() ? { logger: new JsonLogger() } : {}));
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
  console.log(`ITAM API on http://localhost:${port}/api/v1 · OpenAPI at /docs`);
}

void main();
