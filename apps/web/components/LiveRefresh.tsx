'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

interface Props {
  /** Event patterns, e.g. "discovery_run.progress" or "asset.*". */
  types: string;
  /** Only events about this entity (or job) trigger a refresh. */
  entityId?: string;
  jobId?: string;
  /** Stop listening (e.g. the run finished). */
  active?: boolean;
  /** Polling interval used while the stream is down. */
  fallbackMs?: number;
}

/**
 * Re-renders the server component when a matching change is committed. Events are only hints
 * (type and id); the refresh re-reads through the API, so permissions always apply. If the stream
 * fails, it falls back to polling, and says so.
 */
export function LiveRefresh({ types, entityId, jobId, active = true, fallbackMs = 15_000 }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<'live' | 'polling' | 'off'>('off');
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!active) return setMode('off');
    let poll: ReturnType<typeof setInterval> | undefined;
    const refresh = () => {
      // Bursts (a sweep flushing every few seconds, a CSV import) become one refresh.
      clearTimeout(timer.current);
      timer.current = setTimeout(() => router.refresh(), 400);
    };
    const es = new EventSource(`/api/events?types=${encodeURIComponent(types)}`);
    es.addEventListener('open', () => {
      setMode('live');
      if (poll) clearInterval(poll);
      poll = undefined;
    });
    es.addEventListener('change', (ev) => {
      try {
        const e = JSON.parse((ev as MessageEvent).data) as { entityId?: string; jobId?: string };
        if ((entityId && e.entityId !== entityId) || (jobId && e.jobId !== jobId)) return;
        refresh();
      } catch {
        /* ignore malformed */
      }
    });
    es.addEventListener('error', () => {
      // EventSource retries by itself; poll meanwhile so the page never goes stale.
      setMode('polling');
      poll ??= setInterval(() => router.refresh(), fallbackMs);
    });
    return () => {
      es.close();
      if (poll) clearInterval(poll);
      clearTimeout(timer.current);
    };
  }, [types, entityId, jobId, active, fallbackMs, router]);

  if (mode === 'off') return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-400" aria-live="polite">
      <span className={`h-1.5 w-1.5 rounded-full ${mode === 'live' ? 'bg-emerald-400' : 'bg-amber-400'}`} aria-hidden />
      {mode === 'live' ? 'Live' : `Reconnecting · refreshing every ${Math.round(fallbackMs / 1000)} s`}
    </span>
  );
}
