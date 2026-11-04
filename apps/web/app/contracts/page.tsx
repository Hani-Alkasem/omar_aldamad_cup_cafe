import Link from 'next/link';
import { Badge, contractTone, Empty, humanType, Section, Unavailable } from '@/components/ui';
import { getCoverageGaps, getExpiring } from '@/lib/api';

export const metadata = { title: 'Contracts' };
export const dynamic = 'force-dynamic';

const WINDOWS = [30, 90, 180, 365] as const;

export default async function ContractsPage({ searchParams }: { searchParams: { within?: string } }) {
  const within = WINDOWS.find((w) => String(w) === searchParams.within) ?? 90;
  const [expiring, gaps] = await Promise.all([
    getExpiring(within).then((v) => ({ ok: true as const, v }), () => ({ ok: false as const })),
    getCoverageGaps().then((v) => ({ ok: true as const, v }), () => ({ ok: false as const })),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-white">Contracts and coverage</h1>

      <Section
        title={`Ending in the next ${within} days`}
        action={
          <nav className="flex gap-1" aria-label="Time window">
            {WINDOWS.map((w) => (
              <Link
                key={w}
                href={`/contracts?within=${w}`}
                aria-current={w === within ? 'page' : undefined}
                className={`rounded px-2 py-1 text-xs ${w === within ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                {w}d
              </Link>
            ))}
          </nav>
        }
      >
        {!expiring.ok ? <Unavailable what="contracts" /> : expiring.v.length === 0 ? <Empty>Nothing ends in this window.</Empty> : (
          <>
          <ul className="divide-y divide-slate-800 sm:hidden">
            {expiring.v.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-white"><span className="capitalize">{c.contractType}</span> · {c.vendor.name}</p>
                  <p className="truncate font-mono text-xs text-slate-400">{c.contractNumber} · ends {c.endDate} · {c.assets.length} asset{c.assets.length === 1 ? '' : 's'}</p>
                </div>
                <Badge tone={contractTone(c)}>{c.inNoticeWindow ? (c.autoRenew ? 'auto-renews' : 'notice due') : `${c.daysLeft}d left`}</Badge>
              </li>
            ))}
          </ul>
          <div className="-mx-4 hidden overflow-x-auto sm:block">
            <table className="w-full text-left">
              <thead className="text-xs text-slate-400">
                <tr>
                  <th className="px-4 pb-2 font-medium">Contract</th>
                  <th className="px-4 pb-2 font-medium">Vendor</th>
                  <th className="px-4 pb-2 font-medium">Ends</th>
                  <th className="px-4 pb-2 font-medium">Assets</th>
                  <th className="px-4 pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {expiring.v.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-2"><span className="capitalize text-white">{c.contractType}</span> <span className="font-mono text-xs text-slate-400">{c.contractNumber}</span></td>
                    <td className="px-4 py-2">{c.vendor.name}</td>
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums">{c.endDate}</td>
                    <td className="px-4 py-2">{c.assets.length}</td>
                    <td className="px-4 py-2">
                      <Badge tone={contractTone(c)}>{c.inNoticeWindow ? (c.autoRenew ? 'auto-renews' : 'notice due') : `${c.daysLeft}d left`}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Section>

      <Section title="Active hardware with no warranty or support">
        {!gaps.ok ? <Unavailable what="coverage gaps" /> : gaps.v.length === 0 ? <Empty>Every active device is covered.</Empty> : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {gaps.v.map((a) => (
              <li key={a.id}>
                <Link href={`/assets/${a.id}`} className="flex items-center justify-between gap-3 rounded border border-slate-800 px-3 py-2 hover:border-slate-600">
                  <span className="min-w-0 truncate text-white">{a.name}</span>
                  <span className="shrink-0 text-xs text-slate-400">{humanType(a.type)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
