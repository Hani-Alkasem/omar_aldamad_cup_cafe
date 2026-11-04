import Link from 'next/link';
import { getRacks, type RackListItem } from '@/lib/api';

export const metadata = { title: 'Racks' };

export default async function RacksPage() {
  let racks: RackListItem[] = [];
  let error: string | null = null;
  try {
    racks = await getRacks();
  } catch (e) {
    error = e instanceof Error ? e.message : 'API unavailable';
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-white">Racks</h1>
      {error ? (
        <div className="rounded-md border border-amber-700 bg-amber-950/40 p-4 text-sm text-amber-200">
          Could not load racks from the API ({error}). Start the API and set <code>API_URL</code> and <code>API_TOKEN</code>, or open the{' '}
          <Link className="underline" href="/racks/demo">demo rack</Link>.
        </div>
      ) : racks.length === 0 ? (
        <p className="text-slate-400">No racks yet. Run <code>pnpm --filter @itam/api seed</code> to load demo data.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {racks.map((r) => (
            <li key={r.id}>
              <Link href={`/racks/${r.id}`} className="block rounded-lg border border-slate-800 bg-slate-900 p-4 hover:border-slate-600">
                <p className="font-medium text-white">{r.name}</p>
                <p className="text-sm text-slate-400">
                  {r.room}{r.row ? ` / ${r.row}` : ''} · {r.heightU}U · {r.deviceCount} devices
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
