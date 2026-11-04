import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RacksModule } from '../racks/racks.module';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';

@Module({
  imports: [RacksModule, AuditModule],
  controllers: [AssetsController],
  providers: [AssetsService],
})
export class AssetsModule {}
