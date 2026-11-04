import type { RackPowerSummary } from '@itam/shared';
import Link from 'next/link';
import { Badge, Empty, Section, Stat } from '@/components/ui';

const pct = (n: number | null) => (n == null ? null : Math.min(100, Math.max(0, n)));
const tone = (u: number | null) => (u == null ? 'bg-slate-500' : u >= 80 ? 'bg-red-500' : u >= 60 ? 'bg-amber-500' : 'bg-emerald-500');

/** Rack power budget: PDU loads against rating, headroom, and devices missing a cord or a redundant feed. */
export function RackPowerPanel({ power }: { power: RackPowerSummary }) {
  const budgetPct = power.maxPowerW ? (power.totalLoadW / power.maxPowerW) * 100 : null;
  return (
    <Section title="Power">
      <dl className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Load" value={`${(power.totalLoadW / 1000).toFixed(2)} kW`} />
        <Stat label="Budget" value={power.maxPowerW ? `${(power.maxPowerW / 1000).toFixed(1)} kW` : '—'} />
        <Stat label="Headroom" value={power.headroomW == null ? '—' : `${(power.headroomW / 1000).toFixed(2)} kW`} />
        <Stat label="Heat" value={`${power.btuHr.toLocaleString('en')} BTU/h`} />
      </dl>
      {budgetPct != null && (
        <div className="mb-4">
          <div className="h-2 overflow-hidden rounded bg-slate-800" role="meter" aria-label="Rack power budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(budgetPct)}>
            <div className={`h-full ${tone(budgetPct)}`} style={{ width: `${pct(budgetPct)}%` }} />
          </div>
          <p className="mt-1 text-xs text-slate-400">{Math.round(budgetPct)}% of rack budget</p>
        </div>
      )}

      {power.pdus.length === 0 ? <Empty>No PDUs with outlets in this rack.</Empty> : (
        <ul className="space-y-3">
          {power.pdus.map((p) => (
            <li key={p.pduId}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <Link href={`/assets/${p.pduId}`} className="font-medium text-white hover:underline">
                  {p.pduName} {p.feed && <Badge>Feed {p.feed}</Badge>}
                </Link>
                <span className="text-xs tabular-nums text-slate-400">
                  {p.loadW} W · {p.loadA} A{p.ratedA ? ` / ${p.ratedA} A` : ''} · {p.outletsUsed}/{p.outletsTotal} outlets
                </span>
              </div>
              {p.utilisationPct != null && (
                <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-800">
                  <div className={`h-full ${tone(p.utilisationPct)}`} style={{ width: `${pct(p.utilisationPct)}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {(power.unpowered.length > 0 || power.singleFed.length > 0) && (
        <div className="mt-4 space-y-2 border-t border-slate-800 pt-4">
          {power.unpowered.map((d) => (
            <p key={d.id} className="flex items-center gap-2">
              <Badge tone="bad">No power</Badge>
              <Link href={`/assets/${d.id}`} className="truncate hover:underline">{d.name}</Link>
            </p>
          ))}
          {power.singleFed.map((d) => (
            <p key={d.id} className="flex items-center gap-2">
              <Badge tone="warn">Single feed</Badge>
              <Link href={`/assets/${d.id}`} className="truncate hover:underline">{d.name}</Link>
              <span className="text-xs text-slate-400">{d.feeds.length ? `only ${d.feeds.join('')}` : 'no feed label'}</span>
            </p>
          ))}
        </div>
      )}
    </Section>
  );
}
