import type { RunSpec, SubmitHostsInput } from '@itam/shared';
import { ApiError, type DiscoveryApi } from '../src/api-client';
import type { Collector, ProbeResult } from '../src/collectors/types';
import { executeRun } from '../src/run';

const spec = (extra: Partial<RunSpec> = {}): RunSpec => ({
  runId: 'r1',
  jobId: 'j1',
  protocol: 'ssh',
  targets: ['10.0.0.0/29'],
  maxHosts: 1024,
  options: { timeoutMs: 100, concurrency: 4 },
  leaseSeconds: 120,
  credentials: [
    { id: 'a', name: 'first', kind: 'ssh_password', username: 'u', secret: { password: 'a' } },
    { id: 'b', name: 'second', kind: 'ssh_password', username: 'u', secret: { password: 'b' } },
  ],
  ...extra,
});

class FakeApi implements DiscoveryApi {
  batches: SubmitHostsInput[] = [];
  finished?: unknown;
  failSubmit?: ApiError;
  async openScheduledRun() {
    return { id: 'r1' };
  }
  async claim(): Promise<RunSpec> {
    throw new Error('unused');
  }
  async submit(_: string, body: SubmitHostsInput) {
    if (this.failSubmit) throw this.failSubmit;
    this.batches.push(body);
  }
  async finish(_: string, body: unknown) {
    this.finished = body;
  }
}

/** .1 answers to credential b, .2 rejects everything, .3 errors, the rest are down. */
const collector = (calls: string[]): Collector => ({
  async probe(ip, cred): Promise<ProbeResult> {
    calls.push(`${ip}:${cred.id}`);
    if (ip === '10.0.0.1') return cred.id === 'b' ? { kind: 'facts', facts: { ip, protocol: 'ssh', hostname: 'one' } } : { kind: 'auth_failed', message: 'no' };
    if (ip === '10.0.0.2') return { kind: 'auth_failed', message: 'no' };
    if (ip === '10.0.0.3') return { kind: 'error', message: 'restricted shell' };
    return { kind: 'unreachable' };
  },
});

const deps = (api: DiscoveryApi, calls: string[], extra = {}) => ({ api, collectors: { ssh: collector(calls), snmp: collector(calls) }, log: () => undefined, ...extra });
const sum = (api: FakeApi) => ({
  scanned: api.batches.reduce((n, b) => n + b.scannedDelta, 0),
  hosts: api.batches.flatMap((b) => b.hosts ?? []),
  failures: api.batches.flatMap((b) => b.failures ?? []),
});

describe('executeRun', () => {
  it('tries credentials in order, stops early on unreachable SSH hosts, and reports everything once', async () => {
    const api = new FakeApi();
    const calls: string[] = [];
    const report = await executeRun(spec(), deps(api, calls));
    expect(report).toMatchObject({ status: 'succeeded', scanned: 6, responded: 1, failed: 2 });
    expect(calls.filter((c) => c.startsWith('10.0.0.1:'))).toEqual(['10.0.0.1:a', '10.0.0.1:b']);
    expect(calls.filter((c) => c.startsWith('10.0.0.5:'))).toEqual(['10.0.0.5:a']);
    const s = sum(api);
    expect(s.scanned).toBe(6);
    expect(s.hosts.map((h) => h.hostname)).toEqual(['one']);
    expect(s.failures.map((f) => [f.ip, f.outcome]).sort()).toEqual([['10.0.0.2', 'auth_failed'], ['10.0.0.3', 'error']]);
    expect(api.finished).toEqual({ status: 'succeeded' });
  });

  it('SNMP keeps trying communities on silence (wrong v2c community = timeout)', async () => {
    const calls: string[] = [];
    await executeRun(spec({ protocol: 'snmp' }), deps(new FakeApi(), calls));
    expect(calls.filter((c) => c.startsWith('10.0.0.5:'))).toEqual(['10.0.0.5:a', '10.0.0.5:b']);
  });

  it('stops without finishing when the API says the run is over', async () => {
    const api = new FakeApi();
    api.failSubmit = new ApiError(409, 'RUN_NOT_RUNNING', 'Run is failed');
    const report = await executeRun(spec({ targets: ['10.0.0.0/24'] }), deps(api, [], { batchSize: 1 }));
    expect(report.status).toBe('failed');
    expect(api.finished).toBeUndefined();
  });

  it('finishes as partial when the worker is shutting down', async () => {
    const api = new FakeApi();
    const ac = new AbortController();
    ac.abort();
    const report = await executeRun(spec({ targets: ['10.0.0.0/24'] }), deps(api, [], { signal: ac.signal }));
    expect(report.status).toBe('partial');
    expect(api.finished).toMatchObject({ status: 'partial' });
  });
});
