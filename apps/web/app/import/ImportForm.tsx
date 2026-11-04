'use client';

import Link from 'next/link';
import { useState } from 'react';

type Issue = { row: number; column?: string; message: string };
type Result = { dryRun: boolean; rows: number; create: number; update: number; unchanged: number; ignoredColumns: string[]; plan: Array<{ row: number; action: string; name: string; assetId?: string }> };

/** Pick a file → dry run (nothing written) → review → commit. The commit re-validates everything. */
export function ImportForm() {
  const [csv, setCsv] = useState<string | null>(null);
  const [file, setFile] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (dryRun: boolean) => {
    if (!csv) return;
    setBusy(true);
    setError(null);
    setIssues(null);
    try {
      const res = await fetch(`/api/imports/assets?dryRun=${dryRun}`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: csv });
      const body = await res.json().catch(() => ({}));
      if (res.ok) setResult(body);
      else {
        setResult(null);
        if (body.details?.issues) setIssues(body.details.issues);
        setError(body.message ?? `Import failed (${res.status})`);
      }
    } catch {
      setError('Couldn’t reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="csv" className="mb-1 block text-sm text-slate-300">CSV file</label>
        <input
          id="csv"
          type="file"
          accept=".csv,text/csv"
          className="block w-full text-sm text-slate-300 file:mr-3 file:rounded file:border file:border-slate-600 file:bg-slate-900 file:px-3 file:py-1.5 file:text-white"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            setResult(null);
            setIssues(null);
            setError(null);
            if (!f) return setCsv(null);
            if (f.size > 5 * 1024 * 1024) return setError('Files are limited to 5 MB; split the file.');
            setFile(f.name);
            setCsv(await f.text());
          }}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!csv || busy} onClick={() => send(true)} className="rounded-md border border-slate-600 px-3 py-2 text-sm text-white hover:border-slate-400 disabled:opacity-50">
          {busy ? 'Checking…' : 'Check file'}
        </button>
        {result?.dryRun && (
          <button type="button" disabled={busy} onClick={() => send(false)} className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">
            Import {result.create + result.update} change{result.create + result.update === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {error && <p role="alert" className="rounded border border-red-800 bg-red-950/40 p-3 text-sm text-red-200">{error}</p>}
      {issues && (
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-400"><tr><th className="py-1 pr-4 font-medium">Row</th><th className="py-1 pr-4 font-medium">Column</th><th className="py-1 font-medium">Problem</th></tr></thead>
            <tbody className="divide-y divide-slate-800">
              {issues.map((i, k) => (
                <tr key={k}><td className="py-1 pr-4 tabular-nums">{i.row}</td><td className="py-1 pr-4 font-mono text-xs">{i.column ?? '—'}</td><td className="py-1 text-red-200">{i.message}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result && (
        <div className="space-y-2 text-sm" aria-live="polite">
          <p className={result.dryRun ? 'text-slate-300' : 'text-emerald-300'}>
            {result.dryRun ? `${file}: ready to import. Nothing has been written yet.` : `Imported ${file}.`} {result.create} new · {result.update} updated · {result.unchanged} unchanged
          </p>
          {result.ignoredColumns.length > 0 && <p className="text-xs text-amber-300">Ignored columns: {result.ignoredColumns.join(', ')}</p>}
          <ul className="max-h-72 divide-y divide-slate-800 overflow-y-auto">
            {result.plan.map((p) => (
              <li key={p.row} className="flex justify-between gap-3 py-1">
                <span className="min-w-0 truncate">{p.assetId && !result.dryRun ? <Link className="text-sky-400 hover:underline" href={`/assets/${p.assetId}`}>{p.name}</Link> : p.name}</span>
                <span className="shrink-0 text-xs text-slate-400">row {p.row} · {p.action}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
