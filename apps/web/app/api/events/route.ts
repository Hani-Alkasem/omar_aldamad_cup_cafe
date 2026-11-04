import { NextResponse, type NextRequest } from 'next/server';
import { requestToken } from '@/lib/auth';
import { API_URL } from '@/lib/proxy';

export const dynamic = 'force-dynamic';

/**
 * Same-origin SSE relay: the browser's EventSource cannot send the session token as a header,
 * so this route attaches it and streams the API's events through untouched. Closing the tab
 * aborts the upstream request.
 */
export async function GET(req: NextRequest) {
  const token = requestToken();
  if (!token) return NextResponse.json({ code: 'UNAUTHENTICATED', message: 'Sign in first' }, { status: 401 });
  const types = req.nextUrl.searchParams.get('types') ?? '*';
  const upstream = await fetch(`${API_URL}/events/stream?types=${encodeURIComponent(types)}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    cache: 'no-store',
    signal: req.signal,
  }).catch(() => null);
  if (!upstream?.ok || !upstream.body) return NextResponse.json({ code: 'STREAM_UNAVAILABLE', message: 'Live updates are unavailable' }, { status: upstream?.status ?? 502 });
  return new Response(upstream.body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive' },
  });
}
