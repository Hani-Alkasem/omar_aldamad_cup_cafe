import 'server-only';
import type { RackElevation } from '@itam/shared';

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
