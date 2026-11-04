import Link from 'next/link';
import { Badge, humanType, Section, Stat, Unavailable } from '@/components/ui';
import { getSummary } from '@/lib/api';

export const metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

function Meter({ pct, label }: { pct: number; label: string }) {
  const v = Math.max(0, Math.min(100, pct));
  const tone = v >= 90 ? 'bg-red-500' : v >= 75 ? 'bg-amber-500' : 'bg-sky-500';
  return (
    <div className="h-1.5 overflow-hidden rounded bg-slate-800" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)}>
      <div className={`h-full ${tone}`} style={{ width: `${v}%` }} />
    </div>
  );
}

const EXPORTS = [
  ['assets', 'Assets'],
  ['ip-addresses', 'IP addresses'],
  ['subnets', 'Subnets'],
  ['contracts', 'Contracts'],
] as const;

export default async function Overview() {
  const s = await getSummary().then((v) => ({ ok: true as const, v }), () => ({ ok: false as const }));
  if (!s.ok) return <Section title="Overview"><Unavailable what="the overview" /></Section>;
  const d = s.v;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold text-white">Overview</h1>
        <nav aria-label="Export" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-400">Export CSV:</span>
          {EXPORTS.map(([k, label]) => (
            <a key={k} href={`/api/export/${k}`} className="text-sky-400 hover:underline">{label}</a>
          ))}
          <Link href="/import" className="rounded border border-slate-600 px-2 py-1 text-white hover:border-slate-400">Import assets</Link>
        </nav>
      </div>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ['Assets', d.assets.total.toLocaleString('en')],
          ['Rack space used', `${d.racks.utilisationPct}%`],
          ['Under warranty or support', `${d.coverage.pct}%`],
          ['Discovery to review', d.discovery.openConflicts],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
            <Stat label={String(label)} value={value} />
          </div>
        ))}
      </dl>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Racks" action={<Link className="text-sm text-sky-400 hover:underline" href="/racks">All racks</Link>}>
          <p className="mb-2 text-slate-300">{d.racks.usedU.toLocaleString('en')} of {d.racks.totalU.toLocaleString('en')} U used across {d.racks.count} racks</p>
          <Meter pct={d.racks.utilisationPct} label="Rack space used" />
          {d.racks.hottest.length > 0 && (
            <>
              <p className="mb-2 mt-4 text-xs text-slate-400">Highest power load against budget</p>
              <ul className="space-y-2">
                {d.racks.hottest.map((r) => (
                  <li key={r.id}>
                    <div className="mb-1 flex justify-between gap-3 text-xs">
                      <Link href={`/racks/${r.id}`} className="truncate text-white hover:underline">{r.name}</Link>
                      <span className="shrink-0 tabular-nums text-slate-400">{(r.loadW / 1000).toFixed(1)} / {(r.maxPowerW / 1000).toFixed(1)} kW</span>
                    </div>
                    <Meter pct={r.pct ?? 0} label={`${r.name} power`} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>

        <Section title="Warranty and contracts" action={<Link className="text-sm text-sky-400 hover:underline" href="/contracts">Contracts</Link>}>
          <p className="mb-2 text-slate-300">{d.coverage.covered} of {d.coverage.eligible} active devices covered</p>
          <Meter pct={d.coverage.pct} label="Coverage" />
          <dl className="mt-4 grid grid-cols-3 gap-4">
            <Stat label="Ending in 30 days" value={d.coverage.expiringIn30} />
            <Stat label="Ending in 90 days" value={d.coverage.expiringIn90} />
            <Stat label="Lapsed last 30 days" value={d.coverage.expiredLast30} />
          </dl>
        </Section>

        <Section title="Busiest subnets">
          {d.ipam.busiest.length === 0 ? <p className="text-slate-400">No subnets yet.</p> : (
            <ul className="space-y-2">
              {d.ipam.busiest.map((n) => (
                <li key={n.id}>
                  <div className="mb-1 flex justify-between gap-3 text-xs">
                    <Link href={`/search?q=${encodeURIComponent(n.cidr)}`} className="truncate font-mono text-white hover:underline">{n.cidr}{n.name ? <span className="font-sans text-slate-400"> · {n.name}</span> : null}</Link>
                    <span className="shrink-0 tabular-nums text-slate-400">{n.used.toLocaleString('en')} used · {n.pct}%</span>
                  </div>
                  <Meter pct={n.pct} label={`${n.cidr} utilisation`} />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Discovery and integrations" action={<Link className="text-sm text-sky-400 hover:underline" href="/discovery">Discovery</Link>}>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label="Enabled jobs" value={d.discovery.enabledJobs} />
            <Stat label="Failing jobs" value={d.discovery.failingJobs ? <Badge tone="bad">{d.discovery.failingJobs}</Badge> : 0} />
            <Stat label="Seen in 7 days" value={d.discovery.seenLast7d} />
            <Stat label="Never discovered" value={d.discovery.neverDiscovered} hint="Servers, VMs and network gear with no discovery record" />
            <Stat label="Webhooks delivered (24 h)" value={d.integrations.last24h.succeeded} />
            <Stat label="Webhooks failing" value={d.integrations.last24h.retrying + d.integrations.last24h.dead ? <Badge tone="warn">{d.integrations.last24h.retrying + d.integrations.last24h.dead}</Badge> : 0} />
          </dl>
          <p className="mt-4 text-xs text-slate-400">By type: {d.assets.byType.map((t) => `${humanType(t.type)} ${t.count}`).join(' · ')}</p>
        </Section>
      </div>
    </div>
  );
}
