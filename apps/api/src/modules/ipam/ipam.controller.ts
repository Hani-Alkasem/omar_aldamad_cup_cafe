import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AllocateIpSchema, CreateSubnetSchema, ReserveIpSchema, type AllocateIpInput, type CreateSubnetInput, type ReserveIpInput } from '@itam/shared';
import { z } from 'zod';
import { zodBody } from '../../common/openapi';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequestId, Roles } from '../auth/decorators';
import { IpamService } from './ipam.service';

const WRITERS = ['admin', 'network_engineer'] as const;
const TreeQuery = z.object({ vrfId: z.string().uuid().optional() });

@ApiTags('ipam')
@ApiBearerAuth()
@Controller()
export class IpamController {
  constructor(private readonly ipam: IpamService) {}

  @Post('subnets')
  @Roles(...WRITERS)
  @ApiOperation({ summary: 'Create a subnet; CIDR is validated and nested under its smallest parent' })
  @ApiBody(zodBody(CreateSubnetSchema))
  create(@Body(new ZodPipe(CreateSubnetSchema)) body: CreateSubnetInput, @CurrentUser() user: AuthUser, @RequestId() rid?: string) {
    return this.ipam.createSubnet(body, user, rid);
  }

  @Get('subnets/tree')
  @ApiOperation({ summary: 'Nested subnet tree with utilisation, optionally for one VRF' })
  tree(@Query(new ZodPipe(TreeQuery)) q: z.infer<typeof TreeQuery>) {
    return this.ipam.tree(q.vrfId);
  }

  @Get('subnets/:id')
  get(@Param('id', UuidPipe) id: string) {
    return this.ipam.getSubnet(id);
  }

  @Get('subnets/:id/ips')
  ips(@Param('id', UuidPipe) id: string) {
    return this.ipam.listIps(id);
  }

  @Post('subnets/:id/allocate')
  @Roles(...WRITERS)
  @ApiOperation({ summary: 'Allocate the next free IP (409 SUBNET_FULL when exhausted)' })
  @ApiBody(zodBody(AllocateIpSchema))
  allocate(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(AllocateIpSchema)) body: AllocateIpInput, @CurrentUser() user: AuthUser, @RequestId() rid?: string) {
    return this.ipam.allocate(id, body, user, rid);
  }

  @Post('subnets/:id/reserve')
  @Roles(...WRITERS)
  @ApiOperation({ summary: 'Reserve or assign a specific IP inside the subnet' })
  @ApiBody(zodBody(ReserveIpSchema))
  reserve(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(ReserveIpSchema)) body: ReserveIpInput, @CurrentUser() user: AuthUser, @RequestId() rid?: string) {
    return this.ipam.reserve(id, body, user, rid);
  }

  @Delete('ip-addresses/:id')
  @Roles(...WRITERS)
  @HttpCode(204)
  release(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() rid?: string) {
    return this.ipam.release(id, user, rid);
  }
}
