import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateApplicationSchema,
  CreateRelationshipSchema,
  GraphQuerySchema,
  SetMembersSchema,
  UpdateApplicationSchema,
  type CreateApplicationInput,
  type CreateRelationshipInput,
  type GraphQuery,
  type SetMembersInput,
  type UpdateApplicationInput,
} from '@itam/shared';
import { z } from 'zod';
import { zodBody } from '../../common/openapi';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequestId, Roles } from '../auth/decorators';
import { CmdbService } from './cmdb.service';

const EDITORS = ['admin', 'network_engineer'] as const;
const AppGraphQuery = GraphQuerySchema.pick({ includeStale: true });

@ApiTags('cmdb')
@ApiBearerAuth()
@Controller()
export class CmdbController {
  constructor(private readonly cmdb: CmdbService) {}

  @Get('cmdb/graph')
  @ApiOperation({ summary: 'Dependency graph around an asset: up (who depends on it), down (what it needs), or both' })
  graph(@Query(new ZodPipe(GraphQuerySchema)) q: GraphQuery) {
    return this.cmdb.graph(q);
  }

  @Get('assets/:id/impact')
  @ApiOperation({ summary: 'Blast radius: assets and applications affected if this asset fails' })
  impact(@Param('id', UuidPipe) id: string) {
    return this.cmdb.impact(id);
  }

  @Post('cmdb/relationships')
  @Roles(...EDITORS)
  @ApiBody(zodBody(CreateRelationshipSchema))
  createRelationship(@Body(new ZodPipe(CreateRelationshipSchema)) body: CreateRelationshipInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.cmdb.createRelationship(body, { user, requestId });
  }

  @Delete('cmdb/relationships/:id')
  @Roles(...EDITORS)
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a manual edge, or a discovered edge that has gone stale' })
  deleteRelationship(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.cmdb.deleteRelationship(id, { user, requestId });
  }

  @Get('applications')
  applications() {
    return this.cmdb.listApplications();
  }

  @Post('applications')
  @Roles(...EDITORS)
  @ApiBody(zodBody(CreateApplicationSchema))
  createApplication(@Body(new ZodPipe(CreateApplicationSchema)) body: CreateApplicationInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.cmdb.createApplication(body, { user, requestId });
  }

  @Get('applications/:id')
  application(@Param('id', UuidPipe) id: string) {
    return this.cmdb.getApplication(id);
  }

  @Patch('applications/:id')
  @Roles(...EDITORS)
  @ApiBody(zodBody(UpdateApplicationSchema))
  updateApplication(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(UpdateApplicationSchema)) body: UpdateApplicationInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.cmdb.updateApplication(id, body, { user, requestId });
  }

  @Put('applications/:id/members')
  @Roles(...EDITORS)
  @ApiBody(zodBody(SetMembersSchema))
  setMembers(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(SetMembersSchema)) body: SetMembersInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.cmdb.setMembers(id, body, { user, requestId });
  }

  @Delete('applications/:id')
  @Roles(...EDITORS)
  @HttpCode(204)
  deleteApplication(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.cmdb.deleteApplication(id, { user, requestId });
  }

  @Get('applications/:id/graph')
  applicationGraph(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(AppGraphQuery)) q: z.infer<typeof AppGraphQuery>) {
    return this.cmdb.applicationGraph(id, q.includeStale);
  }
}
