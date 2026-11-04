'use client';

import { useState } from 'react';

/**
 * Clears the recorded key so the next run records the new one. Destructive to trust, so it names
 * the asset and asks for confirmation.
 */
export function AcceptHostKeyButton({ assetId, assetName }: { assetId: string; assetName: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    if (!window.confirm(`Accept the new SSH host key for ${assetName}? Only do this if you know the machine was reinstalled.`)) return;
    setState('busy');
    setError(null);
    try {
      const res = await fetch(`/api/assets/${assetId}/ssh-host-key`, { method: 'DELETE' });
      if (res.ok) return setState('done');
      const body = await res.json().catch(() => ({}));
      setError(body.message ?? `Couldn’t accept the key (${res.status})`);
    } catch {
      setError('Couldn’t reach the server. Try again.');
    }
    setState('idle');
  };

  if (state === 'done') return <p className="text-xs text-emerald-300">Accepted. The next run records the new key.</p>;
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={accept}
        disabled={state === 'busy'}
        className="rounded border border-amber-700 px-2 py-1 text-xs text-amber-200 hover:border-amber-500 disabled:opacity-50"
      >
        {state === 'busy' ? 'Accepting…' : 'Accept new key'}
      </button>
      {error && <p role="alert" className="mt-1 text-xs text-red-300">{error}</p>}
    </div>
  );
}
