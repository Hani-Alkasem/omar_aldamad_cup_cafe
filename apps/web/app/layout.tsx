import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getMeOrNull } from '@/lib/api';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'ITAM Platform', template: '%s · ITAM Platform' },
  description: 'Assets, racks, IPAM and dependencies in one inventory.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const who = await getMeOrNull();
  if (who === 'expired') redirect('/auth/expired');
  const me = who;
  return (
    <html lang="en">
      <body className="min-h-screen font-sans print:bg-white">
        <header className="border-b print:hidden border-slate-800 bg-slate-950/80">
          <nav className="mx-auto flex max-w-6xl items-center gap-5 overflow-x-auto whitespace-nowrap px-4 py-3 text-sm">
            <Link href="/" className="font-semibold text-white">ITAM</Link>
            <Link href="/racks" className="text-slate-400 hover:text-white">Racks</Link>
            <Link href="/contracts" className="text-slate-400 hover:text-white">Contracts</Link>
            <Link href="/applications" className="text-slate-400 hover:text-white">Applications</Link>
            <Link href="/discovery" className="text-slate-400 hover:text-white">Discovery</Link>
            <Link href="/integrations" className="text-slate-400 hover:text-white">Integrations</Link>
            <form action="/search" role="search" className="ml-auto">
              <label htmlFor="global-search" className="sr-only">Search</label>
              <input id="global-search" name="q" type="search" placeholder="Name, tag, IP, MAC…" className="w-44 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-white placeholder:text-slate-500 focus:border-sky-500 focus:outline-none" />
            </form>
            {me?.ssoEnabled && (
              <form action="/auth/logout" method="post" className="flex items-center gap-3 pl-2">
                <span className="text-xs text-slate-400" title={me.sites.length ? `Can change: ${me.sites.map((s) => s.name).join(', ')}` : 'Can change every site'}>
                  {me.name} · {me.role.replace('_', ' ')}{me.sites.length ? ` · ${me.sites.map((s) => s.name).join(', ')}` : ''}
                </span>
                <button type="submit" className="text-slate-400 hover:text-white">Sign out</button>
              </form>
            )}
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8 print:p-0">{children}</main>
      </body>
    </html>
  );
}
