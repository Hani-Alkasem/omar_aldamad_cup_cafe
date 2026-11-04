import { createServer, type AddressInfo } from 'node:net';
import { buildRequest, summarise } from './adapters';
import { isRetryableStatus, retryDelayMs } from './backoff';
import { sign, verify } from './signing';
import { ForbiddenAddressError, isAllowedAddress, parseAllowList, safeRequest } from './ssrf';

const event = (type: string, data: Record<string, unknown>) => ({ id: '42', type, occurredAt: '2026-11-04T10:00:00.000Z', data });

describe('SSRF guard', () => {
  it.each([
    ['8.8.8.8', true],
    ['10.0.0.1', false],
    ['172.16.5.4', false],
    ['192.168.1.1', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['0.0.0.0', false],
    ['::1', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['::ffff:10.0.0.1', false],
    ['2606:4700::1111', true],
  ])('%s → %s', (ip, ok) => expect(isAllowedAddress(ip)).toBe(ok));

  it('honours an operator allow list', () => {
    expect(isAllowedAddress('10.20.0.5', parseAllowList('10.20.0.0/16, 192.168.0.0/24'))).toBe(true);
    expect(isAllowedAddress('10.21.0.5', parseAllowList('10.20.0.0/16'))).toBe(false);
  });

  it('refuses literal private IPs, http, and hostnames that resolve privately, before any bytes are sent', async () => {
    await expect(safeRequest({ url: 'https://169.254.169.254/latest/meta-data' })).rejects.toBeInstanceOf(ForbiddenAddressError);
    await expect(safeRequest({ url: 'http://example.com/' })).rejects.toThrow(/https/);
    await expect(safeRequest({ url: 'https://user:pw@example.com/' })).rejects.toThrow(/credentials/);

    let connected = false;
    const srv = createServer(() => (connected = true));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as AddressInfo).port;
    // "localhost" resolves to loopback: blocked inside the socket's lookup, so the server never sees a connection.
    await expect(safeRequest({ url: `http://localhost:${port}/`, allowHttp: true })).rejects.toThrow(/non-public/);
    expect(connected).toBe(false);
    await new Promise<void>((r) => srv.close(() => r()));
  });
});

describe('signing', () => {
  it('verifies, and rejects tampering, wrong secrets and stale timestamps', () => {
    const t = 1_800_000_000;
    const h = sign('whsec_test', '{"a":1}', t);
    expect(verify('whsec_test', '{"a":1}', h, 300, t + 10)).toBe(true);
    expect(verify('whsec_test', '{"a":2}', h, 300, t + 10)).toBe(false);
    expect(verify('other', '{"a":1}', h, 300, t + 10)).toBe(false);
    expect(verify('whsec_test', '{"a":1}', h, 300, t + 3600)).toBe(false);
  });
});

describe('backoff', () => {
  it('grows exponentially with jitter, caps at 6 h, and honours Retry-After', () => {
    expect(retryDelayMs(1, undefined, () => 0.5)).toBe(30_000);
    expect(retryDelayMs(3, undefined, () => 0.5)).toBe(120_000);
    expect(retryDelayMs(30, undefined, () => 0.5)).toBe(6 * 3600_000);
    expect(retryDelayMs(1, '120')).toBe(120_000);
  });
  it('retries only what can recover', () => {
    expect([500, 503, 429, 408, 0].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 410, 422].some(isRetryableStatus)).toBe(false);
  });
});

describe('adapters', () => {
  const conflict = event('discovery.conflict', { runId: 'r1', ip: '10.0.0.5', hostname: 'web-07', reason: 'SSH host key changed' });

  it('generic: signed JSON envelope with event and delivery headers', () => {
    const r = buildRequest('generic', { url: 'https://hooks.example.com/itam', secret: { signingSecret: 's3cret-signing-key' }, config: {} }, conflict, '7', { now: 1_800_000_000 });
    expect(r.url).toBe('https://hooks.example.com/itam');
    expect(r.headers).toMatchObject({ 'x-itam-event': 'discovery.conflict', 'x-itam-delivery': '7' });
    expect(verify('s3cret-signing-key', r.body, r.headers['x-itam-signature'], 300, 1_800_000_000)).toBe(true);
    expect(JSON.parse(r.body)).toEqual(conflict);
  });

  it('slack: Block Kit with severity and a link back', () => {
    const r = buildRequest('slack', { url: 'https://hooks.slack.com', secret: { webhookUrl: 'https://hooks.slack.com/services/T/B/X' }, config: {} }, conflict, '7', { baseUrl: 'https://itam.example.com' });
    expect(r.url).toBe('https://hooks.slack.com/services/T/B/X');
    const b = JSON.parse(r.body);
    expect(b.text).toBe(':warning: Discovery needs review: web-07');
    expect(b.blocks[1].elements[0].url).toBe('https://itam.example.com/discovery/runs/r1?outcome=conflict');
  });

  it('jira: issue in the configured project, basic auth, ADF body, delivery label', () => {
    const r = buildRequest('jira', { url: 'https://acme.atlassian.net/', secret: { email: 'bot@acme.com', apiToken: 'tok-123456' }, config: { projectKey: 'OPS', issueType: 'Task' } }, conflict, '7');
    expect(r.url).toBe('https://acme.atlassian.net/rest/api/3/issue');
    expect(r.headers.authorization).toBe(`Basic ${Buffer.from('bot@acme.com:tok-123456').toString('base64')}`);
    const b = JSON.parse(r.body);
    expect(b.fields).toMatchObject({ project: { key: 'OPS' }, issuetype: { name: 'Task' }, summary: 'Discovery needs review: web-07', labels: ['itam', 'discovery-conflict', 'itam-delivery-7'] });
    expect(b.fields.description.type).toBe('doc');
  });

  it('servicenow: incident with urgency from severity and a correlation id', () => {
    const exp = event('contract.expiring', { contractType: 'support', contractNumber: 'DELL-1', daysLeft: 10, vendor: 'Dell', endDate: '2026-11-14', assetCount: 2, autoRenew: false });
    const r = buildRequest('servicenow', { url: 'https://acme.service-now.com', secret: { username: 'itam', password: 'pw' }, config: { assignmentGroup: 'DC Ops' } }, exp, '9');
    expect(r.url).toBe('https://acme.service-now.com/api/now/table/incident');
    expect(JSON.parse(r.body)).toMatchObject({ short_description: 'support contract DELL-1 ends in 10 days', urgency: '1', assignment_group: 'DC Ops', correlation_id: 'itam-9' });
  });

  it('summarise falls back for unknown events', () => {
    expect(summarise(event('application.updated', { after: { name: 'Shop' }, changedFields: ['owner'] }))).toMatchObject({ title: 'application updated: Shop', lines: ['Changed: owner'] });
  });
});
