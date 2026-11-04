import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { VaultModule } from '../discovery/vault.module';
import { DispatcherService } from './dispatcher.service';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/** Admin API for subscriptions. */
@Module({ imports: [AuditModule, VaultModule], controllers: [WebhooksController], providers: [WebhooksService] })
export class IntegrationsModule {}

/** The dispatcher process: no HTTP server, just the delivery loop. */
@Module({ imports: [AuditModule, VaultModule], providers: [DispatcherService], exports: [DispatcherService] })
export class DispatcherModule {}
