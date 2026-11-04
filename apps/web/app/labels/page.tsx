import Link from 'next/link';
import { headers } from 'next/headers';
import QRCode from 'qrcode';
import { Empty } from '@/components/ui';
import { getAsset, listAssets, type Asset } from '@/lib/api';
import { PrintButton } from './PrintButton';

export const metadata = { title: 'Asset labels' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABELS = 200;

/** Prefer a configured origin: the Host header is client-controlled and ends up printed on hardware. */
function baseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const h = headers();
  return `${h.get('x-forwarded-proto') ?? 'http'}://${h.get('x-forwarded-host') ?? h.get('host')}`;
}

async function assetsFor(sp: { ids?: string; rack?: string }): Promise<Asset[]> {
  if (sp.rack && UUID.test(sp.rack)) return (await listAssets({ rackId: sp.rack, limit: String(MAX_LABELS) })).items;
  const ids = (sp.ids ?? '').split(',').filter((id) => UUID.test(id)).slice(0, MAX_LABELS);
  const got = await Promise.all(ids.map((id) => getAsset(id).catch(() => null)));
  return got.filter((a): a is Asset => a !== null);
}

/** Tag-based URLs survive re-imports; untagged assets fall back to the id. */
const labelUrl = (base: string, a: Asset) => (a.assetTag ? `${base}/a/${encodeURIComponent(a.assetTag)}` : `${base}/assets/${a.id}`);

export default async function LabelsPage({ searchParams }: { searchParams: { ids?: string; rack?: string } }) {
  const assets = await assetsFor(searchParams);
  const base = baseUrl();
  const labels = await Promise.all(
    assets.map(async (a) => ({
      asset: a,
      url: labelUrl(base, a),
      // Error-correction M tolerates scuffs on rack-mounted labels; margin 0 because the label has its own padding.
      svg: await QRCode.toString(labelUrl(base, a), { type: 'svg', errorCorrectionLevel: 'M', margin: 0 }),
    })),
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div>
          <h1 className="text-2xl font-semibold text-white">Asset labels</h1>
          <p className="text-sm text-slate-400">{labels.length} label{labels.length === 1 ? '' : 's'} · 57 × 32 mm · scan to open the asset on a phone</p>
        </div>
        <PrintButton disabled={labels.length === 0} />
      </div>

      {labels.length === 0 ? (
        <Empty>
          No assets selected. Open an asset and choose <em>Print label</em>, or add <code>?rack=&lt;rack id&gt;</code> to print a whole rack. <Link className="text-sky-400 underline" href="/racks">Browse racks</Link>
        </Empty>
      ) : (
        <ul className="flex flex-wrap gap-3 print:gap-0">
          {labels.map(({ asset, url, svg }) => (
            <li
              key={asset.id}
              className="flex h-[32mm] w-[57mm] break-inside-avoid items-center gap-[2.5mm] overflow-hidden rounded border border-slate-300 bg-white p-[2.5mm] text-black print:rounded-none print:border-dashed"
            >
              <div className="h-[26mm] w-[26mm] shrink-0 [&>svg]:h-full [&>svg]:w-full" role="img" aria-label={`QR code for ${url}`} dangerouslySetInnerHTML={{ __html: svg }} />
              <div className="min-w-0 leading-tight">
                <p className="line-clamp-2 break-words text-[10pt] font-bold">{asset.name}</p>
                {asset.assetTag && <p className="mt-[1mm] font-mono text-[9pt]">{asset.assetTag}</p>}
                {asset.serialNumber && <p className="truncate font-mono text-[7pt] text-neutral-600">S/N {asset.serialNumber}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
