'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** POSTs to a same-origin proxy route, then refreshes the server-rendered page. */
export function ActionButton({ path, label, busyLabel, doneLabel }: { path: string; label: string; busyLabel: string; doneLabel?: string }) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setState('busy');
    setError(null);
    try {
      const res = await fetch(path, { method: 'POST' });
      if (res.ok) {
        setState('done');
        // The dispatcher picks work up within about a second.
        setTimeout(() => router.refresh(), 1500);
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body.message ?? `Failed (${res.status})`);
    } catch {
      setError('Couldn’t reach the server. Try again.');
    }
    setState('idle');
  };
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button type="button" onClick={go} disabled={state === 'busy'} className="whitespace-nowrap rounded border border-slate-600 px-2 py-1 text-xs text-white hover:border-slate-400 disabled:opacity-50">
        {state === 'busy' ? busyLabel : state === 'done' && doneLabel ? doneLabel : label}
      </button>
      {error && <span role="alert" className="max-w-[14rem] text-right text-xs text-red-300">{error}</span>}
    </span>
  );
}
