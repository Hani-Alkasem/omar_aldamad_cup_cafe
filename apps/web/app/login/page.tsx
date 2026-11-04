import { redirect } from 'next/navigation';
import { oidcEnabled, safeReturnTo } from '@/lib/auth';

export const metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default function LoginPage({ searchParams }: { searchParams: { returnTo?: string; error?: string; signedOut?: string } }) {
  if (!oidcEnabled()) redirect('/racks');
  const returnTo = safeReturnTo(searchParams.returnTo);
  return (
    <div className="mx-auto mt-16 max-w-sm space-y-4 rounded-lg border border-slate-800 bg-slate-900/60 p-6">
      <h1 className="text-xl font-semibold text-white">Sign in to ITAM</h1>
      {searchParams.signedOut && <p className="text-sm text-slate-300">You’re signed out.</p>}
      {searchParams.error && <p role="alert" className="rounded border border-red-800 bg-red-950/40 p-3 text-sm text-red-200">{searchParams.error}</p>}
      <p className="text-sm text-slate-400">Use your organisation account. Your role and the sites you can change come from your groups.</p>
      <a href={`/auth/login?returnTo=${encodeURIComponent(returnTo)}`} className="block rounded-md bg-sky-600 px-4 py-2 text-center text-sm font-medium text-white hover:bg-sky-500">
        Continue with single sign-on
      </a>
    </div>
  );
}
