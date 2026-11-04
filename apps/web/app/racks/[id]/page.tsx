import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RackPowerPanel } from '@/components/rack/RackPowerPanel';
import { RackView } from '@/components/rack/RackView';
import { Section } from '@/components/ui';
import { ApiError, getElevation, getRackPower } from '@/lib/api';

export const dynamic = 'force-dynamic';

export default async function RackPage({ params }: { params: { id: string } }) {
  try {
    const [elevation, power] = await Promise.all([getElevation(params.id), getRackPower(params.id).catch(() => null)]);
    const devices = [...elevation.devices].sort((a, b) => (b.startU ?? 0) - (a.startU ?? 0));
    return (
      <div className="space-y-6">
        <RackView elevation={elevation} />
        <div className="grid gap-4 lg:grid-cols-2">
          {power && <RackPowerPanel power={power} />}
          <Section
            title={`Devices (${devices.length})`}
            action={<Link href={`/labels?rack=${elevation.rack.id}`} className="text-sm text-sky-400 hover:underline">Print labels</Link>}
          >
            <ul className="divide-y divide-slate-800">
              {devices.map((d) => (
                <li key={d.id}>
                  <Link href={`/assets/${d.id}`} className="flex items-center justify-between gap-3 py-2 hover:text-white">
                    <span className="min-w-0 truncate">{d.name}</span>
                    <span className="shrink-0 font-mono text-xs text-slate-400">{d.startU == null ? '0U' : `U${d.startU}`}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    );
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
}
