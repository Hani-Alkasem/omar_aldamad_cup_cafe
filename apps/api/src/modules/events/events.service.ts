import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';
import { Subject } from 'rxjs';

export interface LiveEvent {
  id?: number;
  type: string;
  entity: string;
  entityId: string;
  at: string;
  [k: string]: unknown;
}

/**
 * One LISTEN connection per API replica on the itam_events channel (fed by triggers on the outbox
 * and on run progress), fanned out in-process to SSE clients. Reconnects with backoff; while it is
 * down browsers fall back to slower polling, so nothing breaks, it only gets less live.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Events');
  readonly events$ = new Subject<LiveEvent>();
  private client?: Client;
  private stopped = false;
  private retryMs = 1000;
  connected = false;

  onModuleInit() {
    if (process.env.LIVE_EVENTS === 'false') return;
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const url = new URL(process.env.DATABASE_URL ?? '');
    url.searchParams.delete('connection_limit'); // Prisma-only parameters
    url.searchParams.delete('schema');
    const client = new Client({ connectionString: url.toString(), application_name: 'itam-events', keepAlive: true });
    client.on('notification', (n) => {
      if (n.channel !== 'itam_events' || !n.payload) return;
      try {
        this.events$.next(JSON.parse(n.payload) as LiveEvent);
      } catch {
        /* a malformed payload is dropped, never fatal */
      }
    });
    const retry = (why: string) => {
      if (this.stopped) return;
      this.connected = false;
      this.log.warn(`event listener down (${why}); retrying in ${this.retryMs} ms`);
      setTimeout(() => void this.connect(), this.retryMs).unref();
      this.retryMs = Math.min(this.retryMs * 2, 30_000);
    };
    client.on('error', (e) => {
      void client.end().catch(() => undefined);
      retry(e.message);
    });
    try {
      await client.connect();
      await client.query('LISTEN itam_events');
      this.client = client;
      this.connected = true;
      this.retryMs = 1000;
    } catch (e) {
      void client.end().catch(() => undefined);
      retry((e as Error).message);
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    this.events$.complete();
    await this.client?.end().catch(() => undefined);
  }
}

/** "asset.*", "discovery_run.progress", "*" — the same patterns webhooks use. */
export function matches(type: string, patterns: string[]) {
  return patterns.some((p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))));
}
