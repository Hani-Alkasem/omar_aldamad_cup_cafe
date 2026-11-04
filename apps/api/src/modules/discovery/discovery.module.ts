import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CredentialsService } from './credentials.service';
import { DiscoveryController, DiscoveryInternalController } from './discovery.controller';
import { BullDiscoveryQueue, DiscoveryQueue } from './discovery.queue';
import { JobsService } from './jobs.service';
import { ReconcilerService } from './reconciler.service';
import { RunsService } from './runs.service';
import { Vault } from './vault';

@Module({
  imports: [AuditModule],
  controllers: [DiscoveryController, DiscoveryInternalController],
  providers: [
    { provide: Vault, useFactory: () => new Vault(process.env) },
    { provide: DiscoveryQueue, useClass: BullDiscoveryQueue },
    CredentialsService,
    JobsService,
    RunsService,
    ReconcilerService,
  ],
})
export class DiscoveryModule {}
