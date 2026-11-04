import { Module } from '@nestjs/common';
import { RackPlacementService } from './rack-placement.service';
import { RacksController } from './racks.controller';
import { RacksService } from './racks.service';

@Module({
  controllers: [RacksController],
  providers: [RacksService, RackPlacementService],
  exports: [RackPlacementService],
})
export class RacksModule {}
