import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LifecycleController } from './lifecycle.controller';
import { LifecycleService } from './lifecycle.service';

@Module({ imports: [AuditModule], controllers: [LifecycleController], providers: [LifecycleService] })
export class LifecycleModule {}
