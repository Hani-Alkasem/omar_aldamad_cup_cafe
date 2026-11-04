import type { ReactNode } from 'react';

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-slate-800 bg-slate-900/60">
      <header className="flex items-center justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {action}
      </header>
      <div className="p-4 text-sm">{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="truncate text-base font-medium tabular-nums text-white" title={hint}>{value}</dd>
    </div>
  );
}

const TONES = {
  ok: 'border-emerald-700 bg-emerald-950/50 text-emerald-300',
  warn: 'border-amber-700 bg-amber-950/50 text-amber-300',
  bad: 'border-red-800 bg-red-950/50 text-red-300',
  muted: 'border-slate-700 bg-slate-800/60 text-slate-300',
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}

/** Section body when a sub-request failed: the rest of the page still renders. */
export function Unavailable({ what }: { what: string }) {
  return <p className="text-slate-400">Couldn’t load {what}. Refresh to try again.</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-slate-400">{children}</p>;
}

export const money = (n: number | null | undefined, currency = 'USD') =>
  n == null ? '—' : new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);

export const gb = (n: number) => (n >= 1024 ? `${+(n / 1024).toFixed(1)} TB` : `${n} GB`);

export const contractTone = (c: { status: string; daysLeft: number; inNoticeWindow?: boolean }): Tone =>
  c.status === 'expired' ? 'bad' : c.daysLeft <= 30 || c.inNoticeWindow ? 'warn' : c.status === 'pending' ? 'muted' : 'ok';

const ACRONYMS: Record<string, string> = { pdu: 'PDU', ups: 'UPS', vm: 'VM' };
/** physical_server → Physical server, pdu → PDU. */
export const humanType = (t: string) => {
  const s = t.split('_').map((w) => ACRONYMS[w] ?? w).join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
