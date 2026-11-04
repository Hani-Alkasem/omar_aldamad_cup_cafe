import { Controller, Module, Query, Sse, type MessageEvent, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { filter, finalize, interval, map, merge, type Observable } from 'rxjs';
import { z } from 'zod';
import { sseClients } from '../../common/observability/metrics';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators';
import { EventsService, matches } from './events.service';

const StreamQuery = z.object({
  types: z
    .string()
    .max(500)
    .default('*')
    .transform((s) => s.split(',').map((t) => t.trim()).filter(Boolean))
    .pipe(z.array(z.string().regex(/^(\*|[a-z_]+(\.(\*|[a-z_]+))*)$/)).min(1).max(20)),
});

/** Event types only administrators may see (who touched which credential, webhook, service client). */
const ADMIN_ONLY = /^(credential|webhook|service_client|session|user)\./;

@ApiTags('events')
@ApiBearerAuth()
@Controller()
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /**
   * Server-Sent Events: committed changes and run progress as they happen. Payloads are
   * references (type, entity, id), never data, so clients re-read through the normal,
   * permission-checked API. A comment ping every 25 s keeps proxies from closing idle streams.
   */
  @Sse('events/stream')
  @ApiOperation({ summary: 'Live stream of committed changes (SSE); filter with ?types=asset.*,discovery_run.progress' })
  stream(@Query('types') rawTypes: string | undefined, @CurrentUser() user: AuthUser): Observable<MessageEvent> {
    // Already validated by validateStreamQuery (SSE headers go out before pipes would run).
    const q = StreamQuery.parse({ types: rawTypes });
    sseClients.inc();
    const live = this.events.events$.pipe(
      filter((e) => matches(e.type, q.types) && (user.role === 'admin' || !ADMIN_ONLY.test(e.type))),
      map((e): MessageEvent => ({ type: 'change', id: e.id ? String(e.id) : undefined, data: { type: e.type, entity: e.entity, entityId: e.entityId, at: e.at, ...(e.jobId ? { jobId: e.jobId } : {}), ...(e.status ? { status: e.status } : {}) } })),
    );
    const ping = interval(25_000).pipe(map((): MessageEvent => ({ type: 'ping', data: { connected: this.events.connected } })));
    return merge(live, ping).pipe(finalize(() => sseClients.dec()));
  }
}

/** Runs before the stream opens, so a bad filter is a real 400 instead of an error event. */
function validateStreamQuery(req: Request, res: Response, next: NextFunction) {
  const r = StreamQuery.safeParse({ types: typeof req.query.types === 'string' ? req.query.types : undefined });
  if (!r.success) return void res.status(400).json({ statusCode: 400, code: 'VALIDATION_FAILED', message: 'types must be a comma-separated list such as asset.*,discovery_run.progress' });
  next();
}

@Module({ controllers: [EventsController], providers: [EventsService], exports: [EventsService] })
export class EventsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(validateStreamQuery).forRoutes('events/stream');
  }
}
