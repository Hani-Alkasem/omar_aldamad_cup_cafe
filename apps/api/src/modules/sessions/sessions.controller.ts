import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { forbidden } from '../../common/errors';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { SessionsService } from './sessions.service';

const CreateSession = z.object({ idToken: z.string().min(20).max(16_384) });
const SetSites = z.object({ siteIds: z.array(z.string().uuid()).max(500) });

@ApiTags('auth')
@Controller()
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post('auth/sessions')
  @Public()
  @ApiOperation({ summary: 'Exchange a fresh OIDC ID token (from the web app login) for an opaque session token' })
  create(@Body(new ZodPipe(CreateSession)) body: z.infer<typeof CreateSession>, @Req() req: Request) {
    return this.sessions.createFromIdToken(body.idToken, { ip: req.ip, userAgent: req.header('user-agent') });
  }

  @Get('auth/me')
  @ApiBearerAuth()
  me(@CurrentUser() user: AuthUser) {
    return this.sessions.me(user);
  }

  @Delete('auth/sessions/current')
  @ApiBearerAuth()
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser) {
    if (!user.sessionId) throw forbidden('NOT_A_SESSION', 'This token is not a web session');
    await this.sessions.revoke(user.sessionId, user);
  }

  @Delete('users/:id/sessions')
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign a user out of every session now' })
  revokeAll(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.sessions.revokeAll(id, user);
  }

  @Put('users/:id/sites')
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set the sites a user may change by hand (IdP-mapped sites are managed by login)' })
  setSites(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(SetSites)) body: z.infer<typeof SetSites>, @CurrentUser() user: AuthUser) {
    return this.sessions.setSites(id, body.siteIds, user);
  }
}
