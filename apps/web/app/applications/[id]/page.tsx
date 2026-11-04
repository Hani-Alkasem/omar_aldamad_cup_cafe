import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Empty, humanType, Section } from '@/components/ui';
import { TopologyGraph } from '@/components/topology/TopologyGraph';
import { ApiError, getApplication, getApplicationGraph } from '@/lib/api';
import { TIER } from '@/components/applications';

export const dynamic = 'force-dynamic';

export default async function ApplicationPage({ params }: { params: { id: string } }) {
  let app;
  try {
    app = await getApplication(params.id);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
  const graph = await getApplicationGraph(app.id).catch(() => null);

  return (
    <div className="space-y-4">
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-slate-400"><Link href="/applications" className="hover:text-white">Applications</Link></p>
        <h1 className="break-words text-2xl font-semibold text-white">{app.name}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-400">
          <Badge tone={TIER[app.criticality].tone}>{TIER[app.criticality].label}</Badge>
          {app.owner && <span>Owner: {app.owner}</span>}
        </p>
        {app.description && <p className="mt-2 max-w-prose text-sm text-slate-300">{app.description}</p>}
      </div>

      <Section title={`Assets (${app.members.length})`}>
        {app.members.length === 0 ? <Empty>No assets assigned.</Empty> : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {app.members.map((m) => (
              <li key={m.assetId}>
                <Link href={`/assets/${m.assetId}`} className="flex items-center justify-between gap-3 rounded border border-slate-800 px-3 py-2 hover:border-slate-600">
                  <span className="min-w-0 truncate text-white">{m.name}</span>
                  <span className="shrink-0 text-xs text-slate-400">{m.role ?? humanType(m.type ?? '')}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {graph && graph.edges.length > 0 ? (
        <Section title="Dependencies">
          <TopologyGraph graph={graph} height={480} />
        </Section>
      ) : (
        <Section title="Dependencies"><Empty>No relationships recorded for these assets yet.</Empty></Section>
      )}
    </div>
  );
}
