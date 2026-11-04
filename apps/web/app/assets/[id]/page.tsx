import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, contractTone, Empty, gb, humanType, money, Section, Stat, Unavailable } from '@/components/ui';
import {
  ApiError,
  getAsset,
  getAssetContracts,
  getComponents,
  getFinancials,
  getMaintenance,
  getPorts,
  getPowerPorts,
  type Asset,
} from '@/lib/api';

export const dynamic = 'force-dynamic';

const settle = <T,>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), () => ({ ok: false as const }));

async function load(id: string): Promise<Asset> {
  try {
    return await getAsset(id);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
}

export async function generateMetadata({ params }: { params: { id: string } }) {
  const a = await getAsset(params.id).catch(() => null);
  return { title: a?.name ?? 'Asset' };
}

/** Mobile-first: this is what a technician sees after scanning a rack label. */
export default async function AssetPage({ params }: { params: { id: string } }) {
  const asset = await load(params.id);
  const [components, ports, power, contracts, financials, maintenance] = await Promise.all([
    settle(getComponents(asset.id)),
    settle(getPorts(asset.id)),
    settle(getPowerPorts(asset.id)),
    settle(getAssetContracts(asset.id)),
    settle(getFinancials(asset.id)),
    settle(getMaintenance(asset.id)),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const location = asset.rackId
    ? asset.depth === 'zero_u'
      ? 'Zero-U (side rail)'
      : `U${asset.startU}${asset.sizeU > 1 ? `–U${(asset.startU ?? 0) + asset.sizeU - 1}` : ''} · ${asset.face}${asset.depth === 'half' ? ' (half depth)' : ''}`
    : 'Not racked';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-slate-400">{humanType(asset.type)}</p>
          <h1 className="break-words text-2xl font-semibold text-white">{asset.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-400">
            <Badge tone={asset.status === 'active' ? 'ok' : asset.status === 'maintenance' ? 'warn' : 'muted'}>{asset.status}</Badge>
            {asset.assetTag && <span className="font-mono">{asset.assetTag}</span>}
            {asset.serialNumber && <span className="font-mono">S/N {asset.serialNumber}</span>}
          </div>
        </div>
        <Link href={`/labels?ids=${asset.id}`} className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:border-slate-500">
          Print label
        </Link>
      </div>

      <Section title="Location" action={asset.rackId && <Link className="text-sm text-sky-400 hover:underline" href={`/racks/${asset.rackId}`}>Open rack</Link>}>
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="Position" value={location} />
          <Stat label="Power draw" value={asset.powerDrawW != null ? `${asset.powerDrawW} W` : '—'} />
          <Stat label="Updated" value={asset.updatedAt.slice(0, 10)} />
        </dl>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Warranty and support">
          {!contracts.ok ? <Unavailable what="contracts" /> : contracts.v.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2"><Badge tone="bad">No coverage</Badge><span className="text-slate-400">No contract covers this asset.</span></div>
          ) : (
            <ul className="divide-y divide-slate-800">
              {contracts.v.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="font-medium capitalize text-white">{c.contractType} · {c.vendor.name}</p>
                    <p className="font-mono text-xs text-slate-400">{c.contractNumber} · {c.startDate} → {c.endDate}</p>
                  </div>
                  <Badge tone={contractTone({ ...c, inNoticeWindow: c.noticeBy <= today })}>
                    {c.status === 'expired' ? `expired ${-c.daysLeft}d ago` : c.status === 'pending' ? 'starts later' : `${c.daysLeft}d left`}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Hardware">
          {!components.ok ? <Unavailable what="components" /> : components.v.items.length === 0 ? <Empty>No components recorded.</Empty> : (
            <>
              <dl className="mb-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="CPU cores" value={components.v.summary.cpuCores} />
                <Stat label="Memory" value={gb(components.v.summary.memoryGb)} />
                <Stat label="Disk" value={gb(components.v.summary.diskGb)} />
                <Stat label="GPUs" value={components.v.summary.gpus} />
              </dl>
              <ul className="space-y-1 text-slate-300">
                {components.v.items.map((c) => (
                  <li key={c.id} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate"><span className="uppercase text-slate-500">{c.kind}</span> {[c.manufacturer, c.model].filter(Boolean).join(' ') || '—'}</span>
                    <span className="shrink-0 font-mono text-xs text-slate-400">{c.slot ?? ''}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Section>

        <Section title="Network ports">
          {!ports.ok ? <Unavailable what="ports" /> : ports.v.length === 0 ? <Empty>No ports recorded.</Empty> : (
            <ul className="max-h-80 space-y-1 overflow-y-auto">
              {ports.v.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3">
                  <span className="font-mono text-slate-200">{p.portName}</span>
                  {p.cable ? (
                    <Link href={`/assets/${p.cable.remoteAssetId}`} className="min-w-0 truncate text-right text-sky-400 hover:underline">
                      {p.cable.remoteAssetName} · {p.cable.remotePortName}
                    </Link>
                  ) : (
                    <span className="text-slate-500">free</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Power">
          {!power.ok ? <Unavailable what="power ports" /> : power.v.length === 0 ? <Empty>No power ports recorded.</Empty> : (
            <ul className="max-h-80 space-y-1 overflow-y-auto">
              {power.v.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3">
                  <span className="font-mono text-slate-200">
                    {p.name} {p.feed && <Badge>{p.feed}</Badge>}
                  </span>
                  {p.connection ? (
                    <Link href={`/assets/${p.connection.peerAsset.id}`} className="min-w-0 truncate text-right text-sky-400 hover:underline">
                      {p.connection.peerAsset.name} · {p.connection.peerPortName}
                    </Link>
                  ) : (
                    <span className={p.kind === 'inlet' ? 'text-amber-400' : 'text-slate-500'}>{p.kind === 'inlet' ? 'unplugged' : 'free'}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Financials">
          {!financials.ok ? <Unavailable what="financials" /> : !financials.v.recorded || !financials.v.depreciation ? <Empty>No purchase data recorded.</Empty> : (
            <dl className="grid grid-cols-2 gap-4">
              <Stat label="Cost" value={money(financials.v.depreciation.cost, financials.v.currency)} />
              <Stat label="Book value" value={money(financials.v.depreciation.bookValue, financials.v.currency)} />
              <Stat label="Age" value={`${financials.v.depreciation.ageMonths} mo`} />
              <Stat label="Fully depreciated" value={financials.v.depreciation.fullyDepreciatedOn ?? '—'} />
            </dl>
          )}
        </Section>

        <Section title="Maintenance">
          {!maintenance.ok ? <Unavailable what="maintenance" /> : maintenance.v.length === 0 ? <Empty>No schedules.</Empty> : (
            <ul className="divide-y divide-slate-800">
              {maintenance.v.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate text-white">{m.title}</p>
                    <p className="text-xs text-slate-400">every {m.intervalDays}d · last {m.lastDoneOn ?? 'never'}</p>
                  </div>
                  <Badge tone={m.nextDueOn < today ? 'bad' : m.nextDueOn <= new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10) ? 'warn' : 'ok'}>
                    due {m.nextDueOn}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
