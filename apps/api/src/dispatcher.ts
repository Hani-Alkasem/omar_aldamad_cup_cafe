import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaModule } from './common/prisma.module';
import { DispatcherModule } from './modules/integrations/integrations.module';
import { DispatcherService } from './modules/integrations/dispatcher.service';

@Module({ imports: [PrismaModule, DispatcherModule] })
class DispatcherRoot {}

/** Separate process (same image as the API): node dist/dispatcher.js. Scale it horizontally. */
async function main() {
  const ctx = await NestFactory.createApplicationContext(DispatcherRoot, { logger: ['log', 'warn', 'error'] });
  ctx.enableShutdownHooks();
  const dispatcher = ctx.get(DispatcherService);
  // Container health check: the file's mtime proves the loop is turning.
  const beatFile = process.env.DISPATCHER_HEARTBEAT_FILE ?? '/tmp/dispatcher.alive';
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => dispatcher.stop());
  await dispatcher.run(() => writeFileSync(beatFile, String(Date.now())));
  await ctx.close();
}

void main();
