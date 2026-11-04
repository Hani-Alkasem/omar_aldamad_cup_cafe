import type { WebhookEnvelope, WebhookKind } from '@itam/shared';
import { sign } from './signing';

export interface OutboundRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface Summary {
  title: string;
  lines: string[];
  severity: 'info' | 'warning' | 'critical';
  link?: string;
}

type Data = Record<string, unknown>;
const str = (v: unknown) => (v == null ? '' : String(v));

/** Human wording for chat and tickets. Unknown events still render from their type and entity. */
export function summarise(e: WebhookEnvelope, baseUrl?: string): Summary {
  const d = e.data as Data;
  const after = (d.after ?? d.before ?? {}) as Data;
  const link = (path: string) => (baseUrl ? `${baseUrl.replace(/\/$/, '')}${path}` : undefined);
  switch (e.type) {
    case 'discovery.conflict':
      return {
        title: `Discovery needs review: ${str(d.hostname) || str(d.ip)}`,
        lines: [str(d.reason), `Address ${str(d.ip)}`],
        severity: 'warning',
        link: link(`/discovery/runs/${str(d.runId)}?outcome=conflict`),
      };
    case 'discovery.run.finished': {
      const c = (d.counts ?? {}) as Data;
      return {
        title: `Discovery ${str(d.status)}: ${str(d.jobName)}`,
        lines: [`${str(c.created)} new · ${str(c.updated)} updated · ${str(c.conflict)} to review · ${str(c.failed)} failed`, ...(d.error ? [str(d.error)] : [])],
        severity: d.status === 'failed' ? 'critical' : Number(c.conflict) > 0 ? 'warning' : 'info',
        link: link(`/discovery/runs/${str(d.runId)}`),
      };
    }
    case 'contract.expiring':
      return {
        title: `${str(d.contractType)} contract ${str(d.contractNumber)} ends in ${str(d.daysLeft)} days`,
        lines: [`Vendor ${str(d.vendor)} · ends ${str(d.endDate)} · ${str(d.assetCount)} asset(s)`, d.autoRenew ? 'Auto-renews' : 'Does not auto-renew'],
        severity: Number(d.daysLeft) <= 14 ? 'critical' : 'warning',
        link: link('/contracts'),
      };
    case 'maintenance.due':
      return {
        title: `Maintenance due: ${str(d.title)} on ${str(d.assetName)}`,
        lines: [`Due ${str(d.nextDueOn)}`],
        severity: 'warning',
        link: link(`/assets/${str(d.assetId)}`),
      };
    case 'webhook.ping':
      return { title: 'Test event from ITAM', lines: ['If you can read this, the integration works.'], severity: 'info' };
    default:
      return {
        title: `${e.type.replace(/[._]/g, ' ')}${after.name ? `: ${str(after.name)}` : ''}`,
        lines: (d.changedFields as string[] | undefined)?.length ? [`Changed: ${(d.changedFields as string[]).join(', ')}`] : [],
        severity: 'info',
        link: e.type.startsWith('asset.') ? link(`/assets/${e.data.after ? str((e.data.after as Data).id) : ''}`) : undefined,
      };
  }
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** Atlassian Document Format: one paragraph per line, plus a link. */
const adf = (s: Summary) => ({
  type: 'doc',
  version: 1,
  content: [
    ...s.lines.filter(Boolean).map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] })),
    ...(s.link ? [{ type: 'paragraph', content: [{ type: 'text', text: 'Open in ITAM', marks: [{ type: 'link', attrs: { href: s.link } }] }] }] : []),
  ],
});

/**
 * Build the HTTP request for one delivery. Pure: no I/O, so each format is snapshot-tested.
 * Ticketing targets are at-least-once: a retry after a lost response can create a second ticket,
 * so every ticket carries the delivery id to make duplicates easy to spot.
 */
export function buildRequest(
  kind: WebhookKind,
  target: { url: string; secret: Record<string, string>; config: Record<string, unknown> },
  e: WebhookEnvelope,
  deliveryId: string,
  opts: { baseUrl?: string; now?: number } = {},
): OutboundRequest {
  const json = { 'content-type': 'application/json' };
  const s = summarise(e, opts.baseUrl);
  switch (kind) {
    case 'generic': {
      const body = JSON.stringify(e);
      return {
        url: target.url,
        body,
        headers: {
          ...json,
          'x-itam-event': e.type,
          'x-itam-delivery': deliveryId,
          'x-itam-signature': sign(target.secret.signingSecret, body, opts.now),
        },
      };
    }
    case 'slack': {
      const icon = s.severity === 'critical' ? ':rotating_light:' : s.severity === 'warning' ? ':warning:' : ':information_source:';
      const body = JSON.stringify({
        text: `${icon} ${s.title}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `${icon} *${s.title}*${s.lines.length ? `\n${s.lines.filter(Boolean).join('\n')}` : ''}` } },
          ...(s.link ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in ITAM' }, url: s.link }] }] : []),
          { type: 'context', elements: [{ type: 'mrkdwn', text: `${e.type} · ${e.occurredAt}` }] },
        ],
      });
      return { url: target.secret.webhookUrl, headers: json, body };
    }
    case 'jira': {
      const body = JSON.stringify({
        fields: {
          project: { key: target.config.projectKey },
          issuetype: { name: target.config.issueType ?? 'Task' },
          summary: s.title.slice(0, 250),
          description: adf(s),
          labels: ['itam', e.type.replace(/\./g, '-'), `itam-delivery-${deliveryId}`],
          ...(s.severity === 'critical' ? { priority: { name: 'High' } } : {}),
        },
      });
      return {
        url: `${target.url.replace(/\/$/, '')}/rest/api/3/issue`,
        headers: { ...json, accept: 'application/json', authorization: basic(target.secret.email, target.secret.apiToken) },
        body,
      };
    }
    case 'servicenow': {
      const body = JSON.stringify({
        short_description: s.title.slice(0, 160),
        description: [...s.lines, ...(s.link ? [s.link] : []), `ITAM delivery ${deliveryId} (${e.type})`].join('\n'),
        category: target.config.category ?? 'hardware',
        urgency: s.severity === 'critical' ? '1' : s.severity === 'warning' ? '2' : '3',
        impact: s.severity === 'critical' ? '2' : '3',
        ...(target.config.assignmentGroup ? { assignment_group: target.config.assignmentGroup } : {}),
        correlation_id: `itam-${deliveryId}`,
      });
      return {
        url: `${target.url.replace(/\/$/, '')}/api/now/table/incident`,
        headers: { ...json, accept: 'application/json', authorization: basic(target.secret.username, target.secret.password) },
        body,
      };
    }
  }
}
