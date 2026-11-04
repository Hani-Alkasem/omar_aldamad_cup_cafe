import { NextResponse } from 'next/server';
import { forward, rejectCrossSite } from '@/lib/proxy';

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const denied = rejectCrossSite(req);
  if (denied) return denied;
  if (!/^\d{1,18}$/.test(params.id)) return NextResponse.json({ code: 'INVALID_ID', message: 'Invalid delivery id' }, { status: 400 });
  return forward(`/webhook-deliveries/${params.id}/replay`, { method: 'POST' });
}
