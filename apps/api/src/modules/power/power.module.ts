import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PowerController } from './power.controller';
import { PowerService } from './power.service';

@Module({ imports: [AuditModule], controllers: [PowerController], providers: [PowerService] })
export class PowerModule {}
