import { NextResponse, type NextRequest } from 'next/server';
import { ApiError, lookupAsset } from '@/lib/api';

/** QR labels encode /a/<asset tag>: short, stable across re-imports, and readable by humans. */
export async function GET(req: NextRequest, { params }: { params: { tag: string } }) {
  try {
    const asset = await lookupAsset(decodeURIComponent(params.tag));
    return NextResponse.redirect(new URL(`/assets/${asset.id}`, req.url), 307);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      return new NextResponse(`No asset with tag or serial "${params.tag}".`, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    throw e;
  }
}
