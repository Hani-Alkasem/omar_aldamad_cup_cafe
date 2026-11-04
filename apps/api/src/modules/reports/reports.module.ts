import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RacksModule } from '../racks/racks.module';
import { ExportService } from './export.service';
import { ImportService } from './import.service';
import { ReportsController } from './reports.controller';
import { SearchService } from './search.service';
import { SummaryService } from './summary.service';

@Module({ imports: [AuditModule, RacksModule], controllers: [ReportsController], providers: [SearchService, SummaryService, ExportService, ImportService] })
export class ReportsModule {}
