import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CablingController } from './cabling.controller';
import { CablingService } from './cabling.service';

@Module({ imports: [AuditModule], controllers: [CablingController], providers: [CablingService] })
export class CablingModule {}
