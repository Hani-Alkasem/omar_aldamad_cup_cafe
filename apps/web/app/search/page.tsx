import Link from 'next/link';
import { Badge, Empty, Section } from '@/components/ui';
import { search } from '@/lib/api';

export const metadata = { title: 'Search' };
export const dynamic = 'force-dynamic';

const TYPE: Record<string, string> = { asset: 'Asset', ip: 'IP', subnet: 'Subnet', application: 'Application', rack: 'Rack', contract: 'Contract' };
const KIND: Record<string, string> = { ip: 'IP address', cidr: 'network', mac: 'MAC address', uuid: 'ID', text: 'text' };

export default async function SearchPage({ searchParams }: { searchParams: { q?: string } }) {
  const q = (searchParams.q ?? '').trim().slice(0, 200);
  if (!q) return <Section title="Search"><Empty>Search by name, asset tag, serial, IP, CIDR, MAC or UUID.</Empty></Section>;
  const r = await search(q);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="break-words text-2xl font-semibold text-white">Results for “{q}”</h1>
        <p className="text-sm text-slate-400">Searched as {KIND[r.kind] ?? r.kind} · {r.hits.length} result{r.hits.length === 1 ? '' : 's'}</p>
      </div>
      <Section title="Matches">
        {r.hits.length === 0 ? <Empty>Nothing matches. Check the spelling, or try part of the name.</Empty> : (
          <ul className="divide-y divide-slate-800">
            {r.hits.map((h) => (
              <li key={`${h.type}-${h.id}`}>
                <Link href={h.href} className="flex items-start justify-between gap-3 py-2 hover:text-white">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-white">{h.title}</span>
                    <span className="block truncate text-xs text-slate-400">{h.subtitle}{h.matched !== 'name' ? ` · matched ${h.matched}` : ''}</span>
                  </span>
                  <Badge>{TYPE[h.type]}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
