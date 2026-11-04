import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateServiceClientSchema, TokenRequestSchema, type CreateServiceClientInput, type TokenRequest } from '@itam/shared';
import type { Request } from 'express';
import { zodBody } from '../../common/openapi';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Public, RequestId, Roles } from '../auth/decorators';
import { ServiceClientsService } from './service-clients.service';

@ApiTags('auth')
@Controller()
export class ServiceClientsController {
  constructor(private readonly clients: ServiceClientsService) {}

  @Post('auth/token')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Exchange a service client id and secret for a 15-minute access token' })
  @ApiBody(zodBody(TokenRequestSchema))
  token(@Body(new ZodPipe(TokenRequestSchema)) body: TokenRequest, @Req() req: Request) {
    return this.clients.issueToken(body, req.ip ?? 'unknown');
  }

  @Get('service-clients')
  @Roles('admin')
  @ApiBearerAuth()
  list() {
    return this.clients.list();
  }

  @Post('service-clients')
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a machine client; the secret is returned once' })
  @ApiBody(zodBody(CreateServiceClientSchema))
  create(@Body(new ZodPipe(CreateServiceClientSchema)) body: CreateServiceClientInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.clients.create(body, { user, requestId });
  }

  @Post('service-clients/:id/rotate')
  @Roles('admin')
  @ApiBearerAuth()
  @HttpCode(200)
  rotate(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.clients.rotate(id, { user, requestId });
  }

  @Delete('service-clients/:id')
  @Roles('admin')
  @ApiBearerAuth()
  @HttpCode(204)
  revoke(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.clients.revoke(id, { user, requestId });
  }
}
