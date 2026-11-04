import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MountDepth, RackFace } from '@itam/shared';
import { z } from 'zod';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe';
import { RacksService } from './racks.service';

const FreeSpaceQuery = z.object({
  sizeU: z.coerce.number().int().min(1).max(60).default(1),
  face: RackFace.default('front'),
  depth: MountDepth.default('full'),
});

@ApiTags('racks')
@ApiBearerAuth()
@Controller('racks')
export class RacksController {
  constructor(private readonly racks: RacksService) {}

  @Get()
  @ApiOperation({ summary: 'List racks with location and device count' })
  list() {
    return this.racks.list();
  }

  @Get(':id/elevation')
  @ApiOperation({ summary: 'Devices in a rack plus free U spans per face' })
  elevation(@Param('id', UuidPipe) id: string) {
    return this.racks.elevation(id);
  }

  @Get(':id/free-space')
  @ApiOperation({ summary: 'Start U positions where a device of the given size and depth fits' })
  freeSpace(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(FreeSpaceQuery)) q: z.infer<typeof FreeSpaceQuery>) {
    return this.racks.freeSpace(id, q.sizeU, q.face, q.depth);
  }
}
