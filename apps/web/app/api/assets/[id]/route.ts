import { NextResponse } from 'next/server';
import { forward, rejectCrossSite, UUID } from '@/lib/proxy';

/**
 * Same-origin proxy for rack moves: forwards only { startU } to the API with the
 * server-held token, and passes the API's status and error body straight back.
 */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const denied = rejectCrossSite(req);
  if (denied) return denied;
  if (!UUID.test(params.id)) return NextResponse.json({ code: 'INVALID_ID', message: 'Invalid asset id' }, { status: 400 });
  const body = await req.json().catch(() => null);
  const startU = body?.startU;
  if (!Number.isInteger(startU)) return NextResponse.json({ code: 'VALIDATION_FAILED', message: 'startU must be an integer' }, { status: 400 });
  return forward(`/assets/${params.id}`, { method: 'PATCH', body: { startU } });
}
