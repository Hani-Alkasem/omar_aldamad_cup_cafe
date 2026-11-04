import { NextResponse } from 'next/server';
import { requestToken } from '@/lib/auth';
import { API_URL, rejectCrossSite } from '@/lib/proxy';

const MAX_BYTES = 5 * 1024 * 1024;

/** Relays the CSV verbatim (dry run unless ?dryRun=false); the API validates and reports. */
export async function POST(req: Request) {
  const denied = rejectCrossSite(req);
  if (denied) return denied;
  const body = await req.text();
  if (body.length > MAX_BYTES) return NextResponse.json({ code: 'CSV_TOO_LARGE', message: 'Files are limited to 5 MB; split the file' }, { status: 413 });
  const dryRun = new URL(req.url).searchParams.get('dryRun') === 'false' ? 'false' : 'true';
  const res = await fetch(`${API_URL}/imports/assets?dryRun=${dryRun}`, {
    method: 'POST',
    headers: { 'content-type': 'text/csv', authorization: `Bearer ${requestToken()}` },
    body,
    cache: 'no-store',
  });
  return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
}
