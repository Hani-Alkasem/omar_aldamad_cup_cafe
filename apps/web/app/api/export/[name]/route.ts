import { NextResponse } from 'next/server';
import { requestToken } from '@/lib/auth';
import { API_URL } from '@/lib/proxy';

const ALLOWED = new Set(['assets', 'ip-addresses', 'subnets', 'contracts']);

/** Streams the API's CSV straight through, so large exports never sit in this server's memory. */
export async function GET(_req: Request, { params }: { params: { name: string } }) {
  if (!ALLOWED.has(params.name)) return NextResponse.json({ code: 'NOT_FOUND', message: 'Unknown export' }, { status: 404 });
  const res = await fetch(`${API_URL}/export/${params.name}.csv`, { headers: { authorization: `Bearer ${requestToken()}` }, cache: 'no-store' });
  if (!res.ok || !res.body) return NextResponse.json(await res.json().catch(() => ({ message: 'Export failed' })), { status: res.status || 502 });
  return new Response(res.body, {
    headers: {
      'content-type': res.headers.get('content-type') ?? 'text/csv; charset=utf-8',
      'content-disposition': res.headers.get('content-disposition') ?? `attachment; filename="itam-${params.name}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
