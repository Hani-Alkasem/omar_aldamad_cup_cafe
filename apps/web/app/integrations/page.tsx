import { ActionButton } from '@/components/ActionButton';
import { Badge, Empty, Section, Unavailable, type Tone } from '@/components/ui';
import { when } from '@/components/discovery/tones';
import { ApiError, getDeliveries, getWebhooks, type Delivery } from '@/lib/api';

export const metadata = { title: 'Integrations' };
export const dynamic = 'force-dynamic';

const KIND: Record<string, string> = { generic: 'Webhook (signed)', slack: 'Slack', jira: 'Jira', servicenow: 'ServiceNow' };
const STATUS: Record<Delivery['status'], { tone: Tone; label: string }> = {
  succeeded: { tone: 'ok', label: 'delivered' },
  pending: { tone: 'muted', label: 'queued' },
  failed: { tone: 'warn', label: 'retrying' },
  dead: { tone: 'bad', label: 'gave up' },
};

export default async function IntegrationsPage() {
  let hooks;
  try {
    hooks = { ok: true as const, v: await getWebhooks() };
  } catch (e) {
    hooks = { ok: false as const, forbidden: e instanceof ApiError && e.status === 403 };
  }
  const recent = new Map<string, Delivery[]>();
  if (hooks.ok) await Promise.all(hooks.v.map(async (h) => recent.set(h.id, await getDeliveries(h.id).catch(() => []))));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-white">Integrations</h1>
        <p className="text-sm text-slate-400">Events go out through a transactional outbox: a change and its notifications commit together, and failed deliveries retry for about a day.</p>
      </div>

      {!hooks.ok ? (
        <Section title="Subscriptions">{hooks.forbidden ? <Empty>Only administrators can see integrations.</Empty> : <Unavailable what="integrations" />}</Section>
      ) : hooks.v.length === 0 ? (
        <Section title="Subscriptions">
          <Empty>No integrations yet. Create one with <code>POST /api/v1/webhooks</code>: a signed webhook, Slack, Jira or ServiceNow.</Empty>
        </Section>
      ) : (
        hooks.v.map((h) => {
          const t = h.health.last24h;
          const total = t.succeeded + t.failed + t.dead;
          const rate = total ? Math.round((t.succeeded / total) * 100) : null;
          const ds = recent.get(h.id) ?? [];
          return (
            <Section
              key={h.id}
              title={h.name}
              action={<ActionButton path={`/api/webhooks/${h.id}/test`} label="Send test" busyLabel="Sending…" doneLabel="Sent" />}
            >
              <div className="mb-3 space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <Badge>{KIND[h.kind]}</Badge>
                  {!h.isEnabled && <Badge tone="muted">disabled</Badge>}
                  <span className="break-all font-mono text-xs text-slate-400">{h.url}</span>
                </p>
                <p className="text-xs text-slate-400">Events: <span className="font-mono">{h.eventTypes.join(', ')}</span></p>
                <p className="text-xs text-slate-400">
                  Last 24 h: {rate == null ? 'nothing sent' : `${rate}% delivered (${t.succeeded}/${total})`}
                  {t.failed ? ` · ${t.failed} retrying` : ''}
                  {t.dead ? ` · ${t.dead} gave up` : ''}
                  {h.health.lastDeliveredAt ? ` · last delivered ${when(h.health.lastDeliveredAt)}` : ''}
                </p>
              </div>
              {ds.length === 0 ? <Empty>No deliveries yet.</Empty> : (
                <ul className="divide-y divide-slate-800">
                  {ds.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2">
                          <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
                          <span className="font-mono text-xs text-slate-200">{d.eventType}</span>
                          <span className="text-xs text-slate-500">#{d.id} · {when(d.createdAt)}</span>
                        </p>
                        <p className="text-xs text-slate-400 [overflow-wrap:anywhere]">
                          {d.attempts} attempt{d.attempts === 1 ? '' : 's'}
                          {d.lastStatusCode ? ` · HTTP ${d.lastStatusCode}` : ''}
                          {d.responseMs != null ? ` · ${d.responseMs} ms` : ''}
                          {d.status === 'failed' && d.nextAttemptAt ? ` · next try ${when(d.nextAttemptAt)}` : ''}
                          {d.lastError && d.status !== 'succeeded' ? ` · ${d.lastError}` : ''}
                        </p>
                      </div>
                      {(d.status === 'dead' || d.status === 'failed') && <ActionButton path={`/api/webhook-deliveries/${d.id}/replay`} label="Replay" busyLabel="Queuing…" doneLabel="Queued" />}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          );
        })
      )}
    </div>
  );
}
