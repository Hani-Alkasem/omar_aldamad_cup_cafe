'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Queues a run through the same-origin proxy, then opens it. A 409 links to the run already in flight. */
export function RunNowButton({ jobId, disabled }: { jobId: string; disabled?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/discovery/jobs/${jobId}/run`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return router.push(`/discovery/runs/${body.id}`);
      if (res.status === 409 && body.details?.runId) return router.push(`/discovery/runs/${body.details.runId}`);
      setError(body.message ?? `Couldn’t start the run (${res.status})`);
    } catch {
      setError('Couldn’t reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={run}
        disabled={disabled || busy}
        className="whitespace-nowrap rounded-md border border-slate-600 px-3 py-1.5 text-sm text-white hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Queuing…' : 'Run now'}
      </button>
      {error && <p role="alert" className="max-w-[16rem] text-right text-xs text-red-300">{error}</p>}
    </div>
  );
}
