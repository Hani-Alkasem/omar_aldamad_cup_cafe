import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ComponentsController } from './components.controller';
import { ComponentsService } from './components.service';

@Module({ imports: [AuditModule], controllers: [ComponentsController], providers: [ComponentsService] })
export class ComponentsModule {}
