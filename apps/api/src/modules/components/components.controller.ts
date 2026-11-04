import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { CreateComponentSchema, type CreateComponentInput } from '@itam/shared';
import { zodBody } from '../../common/openapi';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequestId, Roles } from '../auth/decorators';
import { ComponentsService } from './components.service';

@ApiTags('components')
@ApiBearerAuth()
@Controller()
export class ComponentsController {
  constructor(private readonly components: ComponentsService) {}

  @Get('assets/:id/components')
  list(@Param('id', UuidPipe) id: string) {
    return this.components.list(id);
  }

  @Post('assets/:id/components')
  @Roles('admin', 'dc_technician')
  @ApiBody(zodBody(CreateComponentSchema))
  create(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(CreateComponentSchema)) body: CreateComponentInput, @CurrentUser() user: AuthUser, @RequestId() rid?: string) {
    return this.components.create(id, body, user, rid);
  }

  @Delete('components/:id')
  @Roles('admin', 'dc_technician')
  @HttpCode(204)
  remove(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() rid?: string) {
    return this.components.remove(id, user, rid);
  }
}
