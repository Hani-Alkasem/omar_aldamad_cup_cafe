import { NextResponse } from 'next/server';
import { forward, rejectCrossSite, UUID } from '@/lib/proxy';

/** Accept a changed SSH host key after a confirmed reinstall. The API enforces admin or dc_technician. */
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const denied = rejectCrossSite(req);
  if (denied) return denied;
  if (!UUID.test(params.id)) return NextResponse.json({ code: 'INVALID_ID', message: 'Invalid asset id' }, { status: 400 });
  return forward(`/assets/${params.id}/discovery/ssh-host-key`, { method: 'DELETE' });
}
