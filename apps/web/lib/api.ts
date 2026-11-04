import 'server-only';
import type { DepreciationSummary, RackElevation, RackPowerSummary } from '@itam/shared';

/** Server-side API client. The token stays on the server; the browser only talks to Next. */
const API_URL = process.env.API_URL ?? 'http://localhost:4000/api/v1';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    cache: 'no-store',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.API_TOKEN ?? ''}`, ...init.headers },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.code ?? 'ERROR', body?.message ?? res.statusText);
  return body as T;
}

export interface RackListItem {
  id: string;
  name: string;
  heightU: number;
  room: string;
  row: string | null;
  deviceCount: number;
}

export const getRacks = () => api<RackListItem[]>('/racks');
export const getElevation = (id: string) => api<RackElevation>(`/racks/${id}/elevation`);

/* ---------- Phase 2: asset detail, lifecycle, cabling, power ---------- */

export interface Asset {
  id: string;
  name: string;
  assetTag: string | null;
  serialNumber: string | null;
  type: string;
  status: string;
  rackId: string | null;
  startU: number | null;
  sizeU: number;
  face: 'front' | 'rear' | null;
  depth: 'full' | 'half' | 'zero_u';
  powerDrawW: number | null;
  updatedAt: string;
}

export interface Component {
  id: string;
  kind: 'cpu' | 'memory' | 'disk' | 'gpu' | 'nic' | 'psu' | 'firmware';
  slot: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  capacity: number | null;
}
export interface Components {
  items: Component[];
  summary: { cpuCores: number; memoryGb: number; diskGb: number; gpus: number };
}

export interface NetworkPort {
  id: string;
  portName: string;
  kind: string;
  macAddress: string | null;
  speedMbps: number | null;
  cable: { id: string; remotePortName: string | null; remoteAssetId: string | null; remoteAssetName: string | null } | null;
}

export interface PowerPort {
  id: string;
  name: string;
  kind: 'inlet' | 'outlet';
  feed: 'A' | 'B' | 'C' | null;
  voltage: number;
  maxAmps: number | null;
  connection: { id: string; peerPortName: string; peerAsset: { id: string; name: string } } | null;
}

export interface Contract {
  id: string;
  vendor: { id: string; name: string };
  contractType: string;
  contractNumber: string;
  startDate: string;
  endDate: string;
  noticeBy: string;
  daysLeft: number;
  status: 'active' | 'expired' | 'pending';
  autoRenew: boolean;
  assets: Array<{ id: string; name: string; assetTag: string | null }>;
  inNoticeWindow?: boolean;
}

export interface Financials {
  assetId: string;
  recorded: boolean;
  purchaseCost?: number | null;
  currency?: string;
  purchaseDate?: string | null;
  inServiceDate?: string | null;
  depreciation: DepreciationSummary | null;
}

export interface Maintenance {
  id: string;
  title: string;
  intervalDays: number;
  lastDoneOn: string | null;
  nextDueOn: string;
}

export interface CoverageGap {
  id: string;
  name: string;
  type: string;
  assetTag: string | null;
  serialNumber: string | null;
}

const enc = encodeURIComponent;
export const getAsset = (id: string) => api<Asset>(`/assets/${enc(id)}`);
export const lookupAsset = (tag: string) => api<Asset>(`/assets/lookup?tag=${enc(tag)}`);
export const listAssets = (q: Record<string, string>) => api<{ items: Asset[]; total: number }>(`/assets?${new URLSearchParams(q)}`);
export const getComponents = (id: string) => api<Components>(`/assets/${enc(id)}/components`);
export const getPorts = (id: string) => api<NetworkPort[]>(`/assets/${enc(id)}/ports`);
export const getPowerPorts = (id: string) => api<PowerPort[]>(`/assets/${enc(id)}/power-ports`);
export const getAssetContracts = (id: string) => api<Contract[]>(`/assets/${enc(id)}/contracts`);
export const getFinancials = (id: string) => api<Financials>(`/assets/${enc(id)}/financials`);
export const getMaintenance = (id: string) => api<Maintenance[]>(`/assets/${enc(id)}/maintenance`);
export const getExpiring = (withinDays: number) => api<Contract[]>(`/contracts/expiring?withinDays=${withinDays}`);
export const getCoverageGaps = () => api<CoverageGap[]>('/contracts/coverage-gaps');
export const getRackPower = (id: string) => api<RackPowerSummary>(`/racks/${enc(id)}/power`);
