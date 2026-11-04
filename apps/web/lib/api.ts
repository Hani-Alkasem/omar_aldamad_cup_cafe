import 'server-only';
import { redirect } from 'next/navigation';
import { oidcEnabled, requestToken } from './auth';
import type { DepreciationSummary, Graph, RackElevation, RackPowerSummary } from '@itam/shared';

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
    headers: { 'content-type': 'application/json', authorization: `Bearer ${requestToken()}`, ...init.headers },
  });
  // An expired or revoked SSO session: send the user to sign in again.
  if (res.status === 401 && oidcEnabled()) redirect('/auth/expired');
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
  systemUuid: string | null;
  lastDiscoveredAt: string | null;
  customFields: Record<string, unknown>;
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

/* ---------- Phase 3: discovery ---------- */

export interface DiscoveryJob {
  id: string;
  name: string;
  protocol: 'snmp' | 'ssh';
  targets: string[];
  maxHosts: number;
  scheduleCron: string | null;
  nextRuns: string[];
  isEnabled: boolean;
  credentials: Array<{ id: string; name: string; kind: string }>;
  lastRunAt: string | null;
  lastRunStatus: 'never_run' | 'queued' | 'running' | 'succeeded' | 'failed' | 'partial';
}

export interface DiscoveryRun {
  id: string;
  jobId: string;
  trigger: 'manual' | 'schedule';
  status: DiscoveryJob['lastRunStatus'];
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: { total: number; scanned: number; responded: number };
  counts: { created: number; updated: number; unchanged: number; conflict: number; failed: number };
  error: string | null;
}

export type DiscoveryOutcome = 'created' | 'updated' | 'unchanged' | 'conflict' | 'auth_failed' | 'error';
export interface DiscoveryResult {
  id: string;
  ip: string;
  outcome: DiscoveryOutcome;
  asset: { id: string; name: string } | null;
  matchedBy: string | null;
  changes: Record<string, unknown>;
  message: string | null;
  hostname: string | null;
  os: string | null;
}

export const getDiscoveryJobs = () => api<DiscoveryJob[]>('/discovery/jobs');
export const getDiscoveryJob = (id: string) => api<DiscoveryJob>(`/discovery/jobs/${enc(id)}`);
export const getJobRuns = (id: string, limit = 10) => api<DiscoveryRun[]>(`/discovery/jobs/${enc(id)}/runs?limit=${limit}`);
export const getRun = (id: string) => api<DiscoveryRun>(`/discovery/runs/${enc(id)}`);
export const getRunResults = (id: string, outcome?: DiscoveryOutcome) =>
  api<DiscoveryResult[]>(`/discovery/runs/${enc(id)}/results${outcome ? `?outcome=${outcome}` : ''}`);

/* ---------- Phase 4: dependency mapping ---------- */

export interface Impact {
  root: { id: string; name: string };
  assets: Array<{ id: string; name: string; type: string; status: string; depth: number }>;
  applications: Array<{ id: string; name: string; criticality: string }>;
}
export interface Application {
  id: string;
  name: string;
  description: string | null;
  owner: string | null;
  criticality: 'tier0' | 'tier1' | 'tier2' | 'tier3';
  members: Array<{ assetId: string; role: string | null; name?: string; type?: string; status?: string }>;
}

export const getGraph = (q: { root: string; depth?: number; direction?: 'up' | 'down' | 'both'; includeStale?: boolean }) =>
  api<Graph>(`/cmdb/graph?${new URLSearchParams({ root: q.root, depth: String(q.depth ?? 2), direction: q.direction ?? 'both', includeStale: String(Boolean(q.includeStale)) })}`);
export const getImpact = (id: string) => api<Impact>(`/assets/${enc(id)}/impact`);
export const getApplications = () => api<Application[]>('/applications');
export const getApplication = (id: string) => api<Application>(`/applications/${enc(id)}`);
export const getApplicationGraph = (id: string, includeStale = false) => api<Graph>(`/applications/${enc(id)}/graph?includeStale=${includeStale}`);

/* ---------- Phase 4: integrations ---------- */
export interface Webhook {
  id: string;
  name: string;
  kind: 'generic' | 'slack' | 'jira' | 'servicenow';
  url: string;
  eventTypes: string[];
  isEnabled: boolean;
  health: { last24h: { succeeded: number; failed: number; dead: number; pending: number }; lastError: string | null; lastDeliveredAt: string | null };
}
export interface Delivery {
  id: string;
  eventType: string;
  status: 'pending' | 'succeeded' | 'failed' | 'dead';
  attempts: number;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  responseMs: number | null;
  createdAt: string;
}
export const getWebhooks = () => api<Webhook[]>('/webhooks');
export const getDeliveries = (id: string, limit = 8) => api<Delivery[]>(`/webhooks/${enc(id)}/deliveries?limit=${limit}`);

export interface Me {
  id: string;
  email: string;
  name: string;
  role: string;
  authSource: string;
  sites: Array<{ id: string; name: string }>;
  ssoEnabled: boolean;
}
/**
 * For the layout. Returns 'expired' when the browser holds a session the API refuses, so the layout
 * can route through /auth/expired (pages may swallow redirects in their own error handling).
 */
export async function getMeOrNull(): Promise<Me | null | 'expired'> {
  const token = requestToken();
  if (!token) return null;
  const res = await fetch(`${API_URL}/auth/me`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' }).catch(() => null);
  if (res?.status === 401 && oidcEnabled()) return 'expired';
  return res?.ok ? ((await res.json()) as Me) : null;
}

/* ---------- Phase 5B: search and reports ---------- */
export interface SearchHit {
  type: 'asset' | 'ip' | 'subnet' | 'application' | 'rack' | 'contract';
  id: string;
  title: string;
  subtitle: string;
  href: string;
  score: number;
  matched: string;
}
export const search = (q: string) => api<{ query: string; kind: string; hits: SearchHit[] }>(`/search?q=${enc(q)}&limit=50`);

export interface Summary {
  assets: { total: number; byStatus: Array<{ status: string; count: number }>; byType: Array<{ type: string; count: number }> };
  racks: { count: number; totalU: number; usedU: number; utilisationPct: number; hottest: Array<{ id: string; name: string; loadW: number; maxPowerW: number; pct: number | null }> };
  coverage: { eligible: number; covered: number; pct: number; expiringIn30: number; expiringIn90: number; expiredLast30: number };
  ipam: { busiest: Array<{ id: string; cidr: string; name: string | null; used: number; usable: number; pct: number }> };
  discovery: { enabledJobs: number; failingJobs: number; openConflicts: number; seenLast7d: number; neverDiscovered: number };
  integrations: { last24h: { succeeded: number; retrying: number; dead: number } };
}
export const getSummary = () => api<Summary>('/reports/summary');
