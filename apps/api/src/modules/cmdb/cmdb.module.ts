import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CmdbController } from './cmdb.controller';
import { CmdbService } from './cmdb.service';

@Module({ imports: [AuditModule], controllers: [CmdbController], providers: [CmdbService] })
export class CmdbModule {}
