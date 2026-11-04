import Link from 'next/link';
import { TIER } from '@/components/applications';
import { Badge, Empty, Section, Unavailable } from '@/components/ui';
import { getApplications } from '@/lib/api';

export const metadata = { title: 'Applications' };
export const dynamic = 'force-dynamic';

export default async function ApplicationsPage() {
  const apps = await getApplications().then((v) => ({ ok: true as const, v }), () => ({ ok: false as const }));
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Applications</h1>
        <p className="text-sm text-slate-400">Business services and the assets they run on. An asset’s blast radius lists every application it can take down.</p>
      </div>
      <Section title="Applications">
        {!apps.ok ? <Unavailable what="applications" /> : apps.v.length === 0 ? <Empty>No applications yet. Create one with <code>POST /api/v1/applications</code>.</Empty> : (
          <ul className="divide-y divide-slate-800">
            {apps.v.map((a) => (
              <li key={a.id}>
                <Link href={`/applications/${a.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 hover:text-white">
                  <span className="min-w-0">
                    <span className="font-medium text-white">{a.name}</span>
                    <span className="block text-xs text-slate-400">{a.members.length} asset{a.members.length === 1 ? '' : 's'}{a.owner ? ` · owned by ${a.owner}` : ''}</span>
                  </span>
                  <Badge tone={TIER[a.criticality].tone}>{TIER[a.criticality].label}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
