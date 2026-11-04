import type { Tone } from '@/components/ui';
import type { DiscoveryJob, DiscoveryOutcome } from '@/lib/api';

export const statusTone: Record<DiscoveryJob['lastRunStatus'], Tone> = {
  never_run: 'muted',
  queued: 'muted',
  running: 'warn',
  succeeded: 'ok',
  partial: 'warn',
  failed: 'bad',
};

export const statusLabel: Record<DiscoveryJob['lastRunStatus'], string> = {
  never_run: 'never run',
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  partial: 'partial',
  failed: 'failed',
};

export const outcomeTone: Record<DiscoveryOutcome, Tone> = {
  created: 'ok',
  updated: 'ok',
  unchanged: 'muted',
  conflict: 'warn',
  auth_failed: 'bad',
  error: 'bad',
};

export const outcomeLabel: Record<DiscoveryOutcome, string> = {
  created: 'new asset',
  updated: 'updated',
  unchanged: 'unchanged',
  conflict: 'needs review',
  auth_failed: 'login failed',
  error: 'error',
};

const fmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
export const when = (iso: string | null) => (iso ? `${fmt.format(new Date(iso))} UTC` : '—');

export function duration(from: string | null, to: string | null) {
  if (!from) return '—';
  const s = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
