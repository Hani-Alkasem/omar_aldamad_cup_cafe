import { HttpStatus, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { DISCOVERY_QUEUE, type DiscoveryQueueJob } from '@itam/shared';
import { Queue } from 'bullmq';
import { DomainError } from '../../common/errors';

/** Port so the API can be tested (and run) without Redis. */
export abstract class DiscoveryQueue {
  /** Hand a queued run to the workers. */
  abstract enqueueRun(jobId: string, runId: string): Promise<void>;
  /** Create, replace or remove the repeating schedule for a job. */
  abstract syncSchedule(jobId: string, cron: string | null): Promise<void>;
}

export const queueUnavailable = (cause: unknown) =>
  new DomainError(HttpStatus.SERVICE_UNAVAILABLE, 'QUEUE_UNAVAILABLE', 'The job queue is unreachable; try again shortly', {
    cause: cause instanceof Error ? cause.message : String(cause),
  });

const schedulerId = (jobId: string) => `discovery-job:${jobId}`;

/** BullMQ waits for a connection indefinitely; an HTTP request must not. */
const QUEUE_TIMEOUT_MS = 5000;
async function bounded<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer from Redis in ${QUEUE_TIMEOUT_MS} ms`)), QUEUE_TIMEOUT_MS)))]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class BullDiscoveryQueue extends DiscoveryQueue implements OnModuleDestroy {
  private readonly log = new Logger('DiscoveryQueue');
  private queue?: Queue<DiscoveryQueueJob>;

  /** Lazy: the API starts (and serves everything else) even while Redis is down. */
  private get q() {
    if (!this.queue) {
      const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
      this.queue = new Queue<DiscoveryQueueJob>(DISCOVERY_QUEUE, {
        connection: {
          host: url.hostname,
          port: Number(url.port || 6379),
          username: url.username || undefined,
          password: url.password ? decodeURIComponent(url.password) : undefined,
          tls: url.protocol === 'rediss:' ? {} : undefined,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        },
        defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 },
      });
      this.queue.on('error', (e) => this.log.warn(`redis: ${e.message}`));
    }
    return this.queue;
  }

  async enqueueRun(jobId: string, runId: string) {
    try {
      // jobId doubles as BullMQ's dedupe key: a retried HTTP call cannot enqueue the same run twice.
      await bounded(this.q.add('run', { jobId, runId }, { jobId: `run:${runId}` }));
    } catch (e) {
      throw queueUnavailable(e);
    }
  }

  async syncSchedule(jobId: string, cron: string | null) {
    try {
      if (cron) await bounded(this.q.upsertJobScheduler(schedulerId(jobId), { pattern: cron, tz: process.env.DISCOVERY_TZ ?? 'UTC' }, { name: 'scheduled', data: { jobId } }));
      else await bounded(this.q.removeJobScheduler(schedulerId(jobId)));
    } catch (e) {
      throw queueUnavailable(e);
    }
  }

  async onModuleDestroy() {
    if (!this.queue) return;
    await bounded(this.queue.close()).catch(() => this.queue?.disconnect());
  }
}
