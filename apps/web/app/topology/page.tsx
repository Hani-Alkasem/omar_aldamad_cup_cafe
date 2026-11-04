import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Empty, Section } from '@/components/ui';
import { TopologyGraph } from '@/components/topology/TopologyGraph';
import { ApiError, getApplications, getGraph } from '@/lib/api';

export const metadata = { title: 'Topology' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIRECTIONS = [
  { key: 'both', label: 'Both ways' },
  { key: 'down', label: 'Depends on' },
  { key: 'up', label: 'Used by' },
] as const;

type Search = { root?: string; direction?: string; depth?: string; stale?: string };

const href = (sp: Search, patch: Partial<Search>) => `/topology?${new URLSearchParams(Object.entries({ ...sp, ...patch }).filter(([, v]) => v) as [string, string][])}`;

export default async function TopologyPage({ searchParams: sp }: { searchParams: Search }) {
  if (!sp.root || !UUID.test(sp.root)) {
    const apps = await getApplications().catch(() => []);
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-white">Topology</h1>
        <Section title="Pick a starting point">
          <Empty>Open any asset and choose <em>Show on map</em>, or start from an application:</Empty>
          {apps.length > 0 && (
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {apps.map((a) => (
                <li key={a.id}>
                  <Link href={`/applications/${a.id}`} className="block rounded border border-slate-800 px-3 py-2 hover:border-slate-600">
                    <span className="text-white">{a.name}</span> <span className="text-xs text-slate-400">{a.members.length} assets</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    );
  }

  const direction = DIRECTIONS.find((d) => d.key === sp.direction)?.key ?? 'both';
  const depth = Math.min(Math.max(Number(sp.depth) || 2, 1), 6);
  const includeStale = sp.stale === '1';
  let graph;
  try {
    graph = await getGraph({ root: sp.root, depth, direction, includeStale });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const root = graph.nodes.find((n) => n.isRoot);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-slate-400">Topology</p>
          <h1 className="break-words text-2xl font-semibold text-white">{root?.name ?? 'Asset'}</h1>
          <p className="text-sm text-slate-400">{graph.nodes.length - 1} connected asset{graph.nodes.length === 2 ? '' : 's'} · {graph.edges.length} relationship{graph.edges.length === 1 ? '' : 's'}</p>
        </div>
        <Link href={`/assets/${sp.root}`} className="text-sm text-sky-400 hover:underline">Open asset</Link>
      </div>

      <nav aria-label="Map options" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <span className="flex gap-1">
          {DIRECTIONS.map((d) => (
            <Link key={d.key} href={href(sp, { direction: d.key })} aria-current={d.key === direction ? 'page' : undefined} className={`rounded px-2 py-1 ${d.key === direction ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}>
              {d.label}
            </Link>
          ))}
        </span>
        <span className="flex items-center gap-1 text-slate-400">
          Hops
          {[1, 2, 3, 4].map((n) => (
            <Link key={n} href={href(sp, { depth: String(n) })} aria-current={n === depth ? 'page' : undefined} className={`rounded px-2 py-1 ${n === depth ? 'bg-slate-700 text-white' : 'hover:text-white'}`}>
              {n}
            </Link>
          ))}
        </span>
        <Link href={href(sp, { stale: includeStale ? undefined : '1' })} className="rounded px-2 py-1 text-slate-400 hover:text-white">
          {includeStale ? 'Hide stale' : 'Show stale'}
        </Link>
      </nav>

      {graph.truncated && <p role="status" className="text-sm text-amber-300">This map is large and was cut at 2,000 relationships. Reduce the hops to see all of the nearest ones.</p>}
      {graph.edges.length === 0 ? (
        <Section title="No relationships">
          <Empty>Nothing is known to depend on {root?.name ?? 'this asset'}, and it has no recorded dependencies. SSH discovery records dependencies from live connections; you can also add them through the API.</Empty>
        </Section>
      ) : (
        <TopologyGraph graph={graph} />
      )}
    </div>
  );
}
