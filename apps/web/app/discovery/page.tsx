import Link from 'next/link';
import { Badge, Empty, Section, Unavailable } from '@/components/ui';
import { RunNowButton } from '@/components/discovery/RunNowButton';
import { statusLabel, statusTone, when } from '@/components/discovery/tones';
import { getDiscoveryJobs, getJobRuns, type DiscoveryRun } from '@/lib/api';

export const metadata = { title: 'Discovery' };
export const dynamic = 'force-dynamic';

export default async function DiscoveryPage() {
  const jobs = await getDiscoveryJobs().then((v) => ({ ok: true as const, v }), () => ({ ok: false as const }));
  const latest = new Map<string, DiscoveryRun | undefined>();
  if (jobs.ok) {
    await Promise.all(jobs.v.map(async (j) => latest.set(j.id, (await getJobRuns(j.id, 1).catch(() => []))[0])));
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Discovery</h1>
        <p className="text-sm text-slate-400">Agentless SNMP and SSH sweeps, plus vCenter, AWS and Azure inventories. Results are matched to existing assets by provider id, system UUID, serial, MAC, then IP.</p>
      </div>

      <Section title="Jobs">
        {!jobs.ok ? <Unavailable what="discovery jobs" /> : jobs.v.length === 0 ? (
          <Empty>No discovery jobs yet. Create one with <code>POST /api/v1/discovery/jobs</code> (see the API docs at <code>/docs</code>).</Empty>
        ) : (
          <ul className="divide-y divide-slate-800">
            {jobs.v.map((j) => {
              const run = latest.get(j.id);
              return (
                <li key={j.id} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-white">{j.name}</span>
                      <Badge>{{ vsphere: 'vSphere', aws: 'AWS', azure: 'Azure' }[j.protocol as string] ?? j.protocol.toUpperCase()}</Badge>
                      {!j.isEnabled && <Badge tone="muted">disabled</Badge>}
                    </p>
                    <p className="break-all font-mono text-xs text-slate-400">{(j.targets.length ? j.targets : j.endpoints).join(', ')}</p>
                    <p className="text-xs text-slate-400">
                      {j.scheduleCron ? <>Schedule <code>{j.scheduleCron}</code>{j.nextRuns[0] ? ` · next ${when(j.nextRuns[0])}` : ''}</> : 'Manual only'}
                      {' · '}
                      {j.credentials.length} credential{j.credentials.length === 1 ? '' : 's'}
                    </p>
                    <p className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <Badge tone={statusTone[j.lastRunStatus]}>{statusLabel[j.lastRunStatus]}</Badge>
                      {run && (
                        <Link href={`/discovery/runs/${run.id}`} className="text-sky-400 hover:underline">
                          {when(run.startedAt ?? run.queuedAt)} · {run.progress.responded} found · {run.counts.created} new
                          {run.counts.conflict ? ` · ${run.counts.conflict} to review` : ''}
                        </Link>
                      )}
                    </p>
                  </div>
                  <RunNowButton jobId={j.id} disabled={!j.isEnabled} />
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}
