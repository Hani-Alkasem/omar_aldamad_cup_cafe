import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ServiceClientsController } from './service-clients.controller';
import { ServiceClientsService } from './service-clients.service';

@Module({ imports: [AuditModule], controllers: [ServiceClientsController], providers: [ServiceClientsService] })
export class ServiceClientsModule {}
