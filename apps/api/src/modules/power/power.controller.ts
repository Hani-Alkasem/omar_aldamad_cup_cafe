import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BulkPowerPortsSchema, ConnectPowerSchema, type BulkPowerPortsInput, type ConnectPowerInput } from '@itam/shared';
import { zodBody } from '../../common/openapi';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequestId, Roles } from '../auth/decorators';
import { PowerService } from './power.service';

const WRITERS = ['admin', 'dc_technician'] as const;

@ApiTags('power')
@ApiBearerAuth()
@Controller()
export class PowerController {
  constructor(private readonly power: PowerService) {}

  @Get('assets/:id/power-ports')
  ports(@Param('id', UuidPipe) id: string) {
    return this.power.listPorts(id);
  }

  @Post('assets/:id/power-ports/bulk')
  @Roles(...WRITERS)
  @ApiOperation({ summary: 'Add PSU inlets to a device, or numbered outlets to a PDU/UPS' })
  @ApiBody(zodBody(BulkPowerPortsSchema))
  bulk(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(BulkPowerPortsSchema)) body: BulkPowerPortsInput, @CurrentUser() user: AuthUser, @RequestId() rid?: string) {
    return this.power.bulkPorts(id, body, user, rid);
  }

  @Post('power-connections')
  @Roles(...WRITERS)
  @ApiOperation({ summary: 'Plug an inlet into an outlet; also records a powered_by CMDB edge' })
  @ApiBody(zodBody(ConnectPowerSchema))
  connect(@Body(new ZodPipe(ConnectPowerSchema)) body: ConnectPowerInput, @CurrentUser() user: AuthUser, @RequestId() rid?: string) {
    return this.power.connect(body, user, rid);
  }

  @Delete('power-connections/:id')
  @Roles(...WRITERS)
  @HttpCode(204)
  disconnect(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() rid?: string) {
    return this.power.disconnect(id, user, rid);
  }

  @Get('racks/:id/power')
  @ApiOperation({ summary: 'Rack power budget: per-PDU load, headroom, unpowered and single-fed devices' })
  rackPower(@Param('id', UuidPipe) id: string) {
    return this.power.rackPower(id);
  }
}
