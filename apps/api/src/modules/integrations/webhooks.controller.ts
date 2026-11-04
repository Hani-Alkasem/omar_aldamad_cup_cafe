import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateWebhookSchema, DeliveryStatus, EVENT_TYPES, UpdateWebhookSchema, type CreateWebhookInput, type UpdateWebhookInput } from '@itam/shared';
import { z } from 'zod';
import { zodBody } from '../../common/openapi';
import { UuidPipe, ZodPipe } from '../../common/zod.pipe';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, RequestId, Roles } from '../auth/decorators';
import { WebhooksService } from './webhooks.service';

const DeliveriesQuery = z.object({ status: DeliveryStatus.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

@ApiTags('integrations')
@ApiBearerAuth()
@Controller()
@Roles('admin')
export class WebhooksController {
  constructor(private readonly hooks: WebhooksService) {}

  @Get('webhooks/event-types')
  eventTypes() {
    return EVENT_TYPES;
  }

  @Get('webhooks')
  @ApiOperation({ summary: 'Subscriptions with 24 h delivery health; secrets are never returned' })
  list() {
    return this.hooks.list();
  }

  @Post('webhooks')
  @ApiOperation({ summary: 'Subscribe a generic (HMAC-signed), Slack, Jira or ServiceNow target to events' })
  @ApiBody(zodBody(CreateWebhookSchema))
  create(@Body(new ZodPipe(CreateWebhookSchema)) body: CreateWebhookInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.hooks.create(body, { user, requestId });
  }

  @Patch('webhooks/:id')
  @ApiBody(zodBody(UpdateWebhookSchema))
  update(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(UpdateWebhookSchema)) body: UpdateWebhookInput, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.hooks.update(id, body, { user, requestId });
  }

  @Delete('webhooks/:id')
  @HttpCode(204)
  remove(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.hooks.remove(id, { user, requestId });
  }

  @Post('webhooks/:id/test')
  @HttpCode(202)
  test(@Param('id', UuidPipe) id: string, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.hooks.test(id, { user, requestId });
  }

  @Get('webhooks/:id/deliveries')
  deliveries(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(DeliveriesQuery)) q: z.infer<typeof DeliveriesQuery>) {
    return this.hooks.deliveries(id, q.status, q.limit);
  }

  @Post('webhook-deliveries/:id/replay')
  @HttpCode(202)
  replay(@Param('id') id: string, @CurrentUser() user: AuthUser, @RequestId() requestId?: string) {
    return this.hooks.replay(id, { user, requestId });
  }
}
