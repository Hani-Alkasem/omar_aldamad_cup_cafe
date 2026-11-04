import { NextResponse } from 'next/server';
import { forward, rejectCrossSite, UUID } from '@/lib/proxy';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const denied = rejectCrossSite(req);
  if (denied) return denied;
  if (!UUID.test(params.id)) return NextResponse.json({ code: 'INVALID_ID', message: 'Invalid webhook id' }, { status: 400 });
  return forward(`/webhooks/${params.id}/test`, { method: 'POST' });
}
