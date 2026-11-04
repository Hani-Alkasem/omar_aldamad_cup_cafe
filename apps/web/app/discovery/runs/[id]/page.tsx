import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Empty, Section, Stat } from '@/components/ui';
import { AcceptHostKeyButton } from '@/components/discovery/AcceptHostKeyButton';
import { AutoRefresh } from '@/components/discovery/AutoRefresh';
import { duration, outcomeLabel, outcomeTone, statusLabel, statusTone, when } from '@/components/discovery/tones';
import { ApiError, getDiscoveryJob, getRun, getRunResults, type DiscoveryOutcome } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Discovery run' };

const FILTERS: Array<{ key: DiscoveryOutcome | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'created', label: 'New' },
  { key: 'updated', label: 'Updated' },
  { key: 'conflict', label: 'Needs review' },
  { key: 'auth_failed', label: 'Login failed' },
  { key: 'error', label: 'Errors' },
];

function describeChanges(c: Record<string, unknown>): string | null {
  const parts: string[] = [];
  if (c.serialNumber) parts.push('serial');
  if (c.systemUuid) parts.push('system UUID');
  if (Array.isArray(c.discovery) && c.discovery.length) parts.push(`facts (${(c.discovery as string[]).join(', ')})`);
  const ports = c.ports as { added?: string[]; updated?: string[] } | undefined;
  if (ports?.added?.length) parts.push(`${ports.added.length} port${ports.added.length > 1 ? 's' : ''} added`);
  if (ports?.updated?.length) parts.push(`${ports.updated.length} port${ports.updated.length > 1 ? 's' : ''} updated`);
  if (c.components) parts.push('hardware');
  const ip = c.ip as { assigned?: string; reassigned?: string } | undefined;
  if (ip?.assigned) parts.push('IP recorded');
  if (ip?.reassigned) parts.push('IP moved from another asset');
  return parts.length ? parts.join(' · ') : null;
}

export default async function RunPage({ params, searchParams }: { params: { id: string }; searchParams: { outcome?: string } }) {
  let run;
  try {
    run = await getRun(params.id);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
  const filter = FILTERS.find((f) => f.key === searchParams.outcome)?.key ?? 'all';
  const [job, results] = await Promise.all([getDiscoveryJob(run.jobId).catch(() => null), getRunResults(run.id, filter === 'all' ? undefined : filter)]);
  const active = run.status === 'queued' || run.status === 'running';
  const pct = run.progress.total ? Math.round((run.progress.scanned / run.progress.total) * 100) : active ? 0 : 100;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-slate-400">
            <Link href="/discovery" className="hover:text-white">Discovery</Link> · {run.trigger === 'schedule' ? 'scheduled run' : 'manual run'}
          </p>
          <h1 className="break-words text-2xl font-semibold text-white">{job?.name ?? 'Run'}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-400">
            <Badge tone={statusTone[run.status]}>{statusLabel[run.status]}</Badge>
            <span>{when(run.startedAt ?? run.queuedAt)} · {duration(run.startedAt, run.finishedAt)}</span>
            <AutoRefresh active={active} />
          </p>
        </div>
      </div>

      {run.error && <p role="alert" className="rounded-md border border-red-800 bg-red-950/40 p-3 text-sm text-red-200">{run.error}</p>}

      <Section title="Progress">
        <div className="mb-4">
          <div className="h-2 overflow-hidden rounded bg-slate-800" role="progressbar" aria-label="Hosts scanned" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className={`h-full ${run.status === 'failed' ? 'bg-red-500' : 'bg-sky-500'}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-xs tabular-nums text-slate-400">{run.progress.scanned} of {run.progress.total} addresses probed · {run.progress.responded} answered</p>
        </div>
        <dl className="grid grid-cols-3 gap-4 sm:grid-cols-5">
          <Stat label="New" value={run.counts.created} />
          <Stat label="Updated" value={run.counts.updated} />
          <Stat label="Unchanged" value={run.counts.unchanged} />
          <Stat label="Needs review" value={run.counts.conflict} />
          <Stat label="Failed" value={run.counts.failed} />
        </dl>
      </Section>

      <Section
        title="Hosts"
        action={
          <nav aria-label="Filter hosts" className="-my-1 flex flex-wrap justify-end gap-1">
            {FILTERS.map((f) => (
              <Link
                key={f.key}
                href={f.key === 'all' ? `/discovery/runs/${run.id}` : `/discovery/runs/${run.id}?outcome=${f.key}`}
                aria-current={f.key === filter ? 'page' : undefined}
                className={`rounded px-2 py-1 text-xs ${f.key === filter ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                {f.label}
              </Link>
            ))}
          </nav>
        }
      >
        {results.length === 0 ? (
          <Empty>{filter === 'all' ? (active ? 'No hosts have answered yet.' : 'No host answered. Check targets, ports and firewall rules.') : 'No hosts in this group.'}</Empty>
        ) : (
          <ul className="divide-y divide-slate-800">
            {results.map((r) => {
              const changes = describeChanges(r.changes);
              return (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="break-all font-mono text-slate-200">{r.ip ?? r.key}</span>
                      {r.asset ? (
                        <Link href={`/assets/${r.asset.id}`} className="text-sky-400 hover:underline">{r.asset.name}</Link>
                      ) : (
                        r.hostname && <span className="text-slate-300">{r.hostname}</span>
                      )}
                      {r.matchedBy && <span className="text-xs text-slate-500">matched by {r.matchedBy.replace('_', ' ')}</span>}
                    </p>
                    {r.os && <p className="truncate text-xs text-slate-400">{r.os}</p>}
                    {(r.message || changes) && (
                      <p className={`text-xs [overflow-wrap:anywhere] ${r.outcome === 'conflict' ? 'text-amber-300' : 'text-slate-400'}`}>{r.message ?? changes}</p>
                    )}
                    {r.outcome === 'conflict' && r.asset && /host key changed/i.test(r.message ?? '') && <AcceptHostKeyButton assetId={r.asset.id} assetName={r.asset.name} />}
                  </div>
                  <Badge tone={outcomeTone[r.outcome]}>{outcomeLabel[r.outcome]}</Badge>
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
