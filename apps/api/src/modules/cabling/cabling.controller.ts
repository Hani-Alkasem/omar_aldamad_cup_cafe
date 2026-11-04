import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BulkPortsSchema, CreateCableSchema, CreatePortSchema, type BulkPortsInput, type CreateCableInput, type CreatePortInput } from '@itam/shared';
import { z } from 'zod';
import { zodBody } from '../../common/openapi';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequestId, Roles } from '../auth/decorators';
import { CablingService } from './cabling.service';

const PORT_WRITERS = ['admin', 'dc_technician'] as const;
const CABLE_WRITERS = ['admin', 'dc_technician', 'network_engineer'] as const;
const MacQuery = z.object({ mac: CreatePortSchema.shape.macAddress.unwrap() });

@ApiTags('cabling')
@ApiBearerAuth()
@Controller()
export class CablingController {
  constructor(private readonly cabling: CablingService) {}

  @Get('assets/:id/ports')
  @ApiOperation({ summary: 'Network ports with what each one is cabled to' })
  ports(@Param('id', UuidPipe) id: string) {
    return this.cabling.listPorts(id);
  }

  @Post('assets/:id/ports')
  @Roles(...PORT_WRITERS)
  @ApiBody(zodBody(CreatePortSchema))
  createPort(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(CreatePortSchema)) body: CreatePortInput, @CurrentUser() user: AuthUser, @RequestId() rid?: string) {
    return this.cabling.createPort(id, body, user, rid);
  }

  @Post('assets/:id/ports/bulk')
  @Roles(...PORT_WRITERS)
  @ApiOperation({ summary: 'Create numbered ports, or a paired front/rear patch panel' })
  @ApiBody(zodBody(BulkPortsSchema))
  bulk(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(BulkPortsSchema)) body: BulkPortsInput, @CurrentUser() user: AuthUser, @RequestId() rid?: string) {
    return this.cabling.bulkPorts(id, body, user, rid);
  }

  @Get('ports')
  @ApiOperation({ summary: 'Find ports by MAC address' })
  byMac(@Query(new ZodPipe(MacQuery)) q: z.infer<typeof MacQuery>) {
    return this.cabling.findByMac(q.mac);
  }

  @Delete('ports/:id')
  @Roles(...PORT_WRITERS)
  @HttpCode(204)
  deletePort(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() rid?: string) {
    return this.cabling.deletePort(id, user, rid);
  }

  @Get('ports/:id/trace')
  @ApiOperation({ summary: 'Follow the physical path through cables and patch-panel pass-throughs' })
  trace(@Param('id', UuidPipe) id: string) {
    return this.cabling.trace(id);
  }

  @Post('cables')
  @Roles(...CABLE_WRITERS)
  @ApiBody(zodBody(CreateCableSchema))
  connect(@Body(new ZodPipe(CreateCableSchema)) body: CreateCableInput, @CurrentUser() user: AuthUser, @RequestId() rid?: string) {
    return this.cabling.connect(body, user, rid);
  }

  @Delete('cables/:id')
  @Roles(...CABLE_WRITERS)
  @HttpCode(204)
  disconnect(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() rid?: string) {
    return this.cabling.disconnect(id, user, rid);
  }
}
