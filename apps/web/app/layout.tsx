import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'ITAM Platform', template: '%s · ITAM Platform' },
  description: 'Assets, racks, IPAM and dependencies in one inventory.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans print:bg-white">
        <header className="border-b print:hidden border-slate-800 bg-slate-950/80">
          <nav className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3 text-sm">
            <Link href="/" className="font-semibold text-white">ITAM</Link>
            <Link href="/racks" className="text-slate-400 hover:text-white">Racks</Link>
            <Link href="/contracts" className="text-slate-400 hover:text-white">Contracts</Link>
            <Link href="/discovery" className="text-slate-400 hover:text-white">Discovery</Link>
          </nav>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-8 print:p-0">{children}</main>
      </body>
    </html>
  );
}
