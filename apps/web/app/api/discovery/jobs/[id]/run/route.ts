import { NextResponse } from 'next/server';
import { forward, rejectCrossSite, UUID } from '@/lib/proxy';

/** "Run now" from the jobs page. The API enforces the role (admin or network_engineer). */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const denied = rejectCrossSite(req);
  if (denied) return denied;
  if (!UUID.test(params.id)) return NextResponse.json({ code: 'INVALID_ID', message: 'Invalid job id' }, { status: 400 });
  return forward(`/discovery/jobs/${params.id}/run`, { method: 'POST' });
}
