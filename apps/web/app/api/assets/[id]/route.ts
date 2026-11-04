import { NextResponse } from 'next/server';

const API_URL = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Same-origin proxy for rack moves: forwards only { startU } to the API with the
 * server-held token, and passes the API's status and error body straight back.
 */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  if (!UUID.test(params.id)) return NextResponse.json({ code: 'INVALID_ID', message: 'Invalid asset id' }, { status: 400 });
  const body = await req.json().catch(() => null);
  const startU = body?.startU;
  if (!Number.isInteger(startU)) return NextResponse.json({ code: 'VALIDATION_FAILED', message: 'startU must be an integer' }, { status: 400 });

  const res = await fetch(`${API_URL}/assets/${params.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.API_TOKEN ?? ''}` },
    body: JSON.stringify({ startU }),
    cache: 'no-store',
  });
  return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
}
