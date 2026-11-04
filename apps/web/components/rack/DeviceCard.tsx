import { WATTS_TO_BTU_HR, type RackDevice } from '@itam/shared';

const STATUS_LABEL: Record<RackDevice['status'], string> = {
  planned: 'Planned',
  in_stock: 'In stock',
  active: 'Active',
  maintenance: 'Maintenance',
  retired: 'Retired',
  disposed: 'Disposed',
};

const DEPTH_LABEL: Record<RackDevice['depth'], string> = { full: 'Full depth', half: 'Half depth', zero_u: 'Zero-U' };

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-slate-400">{label}</dt>
      <dd className="text-right font-medium text-slate-100">{value}</dd>
    </div>
  );
}

/** Telemetry card shown on hover and keyboard focus. */
export function DeviceCard({ device, id }: { device: RackDevice; id: string }) {
  const range =
    device.startU == null ? 'Side channel' : device.sizeU === 1 ? `U${device.startU}` : `U${device.startU}–U${device.startU + device.sizeU - 1}`;
  return (
    <div
      id={id}
      role="tooltip"
      className="pointer-events-none w-64 rounded-md border border-slate-700 bg-slate-900/95 p-3 text-xs text-slate-200 shadow-xl backdrop-blur"
    >
      <p className="truncate text-sm font-semibold text-white">{device.name}</p>
      <p className="mb-2 truncate text-slate-400">{device.model ?? device.type.replace(/_/g, ' ')}</p>
      <dl className="space-y-1">
        <Row label="Position" value={`${range} · ${device.sizeU}U`} />
        <Row label="Mount" value={`${DEPTH_LABEL[device.depth]}${device.face ? ` · ${device.face}` : ''}`} />
        <Row label="Status" value={STATUS_LABEL[device.status]} />
        <Row label="Power" value={device.powerW ? `${device.powerW} W · ${Math.round(device.powerW * WATTS_TO_BTU_HR)} BTU/h` : '—'} />
        <Row label="Inlet temp" value={device.tempC != null ? `${device.tempC} °C` : '—'} />
        <Row label="Ports" value={device.ports ?? '—'} />
      </dl>
    </div>
  );
}
