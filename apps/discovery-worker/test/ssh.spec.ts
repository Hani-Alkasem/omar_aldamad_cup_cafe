import { createServer, type AddressInfo } from 'node:net';
import { Server, utils } from 'ssh2';
import { fingerprint, SshCollector } from '../src/collectors/ssh';
import type { Credential } from '../src/collectors/types';

const hostKey = utils.generateKeyPairSync('ed25519');
const clientKey = utils.generateKeyPairSync('ed25519');
const clientPub = utils.parseKey(clientKey.public);

const INVENTORY = '@@hostname\nlab-01\n@@uuid\n4c4c4544-0042-3510-8051-b4c04f4b4e32\n@@serial\nABC123\n@@cpus\n8\n@@links\neth0 52:54:00:aa:bb:cc 10000\n@@end\n';

let server: Server;
let port: number;
let commands: string[] = [];

beforeAll(async () => {
  server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.username !== 'discovery') return ctx.reject();
      if (ctx.method === 'password' && ctx.password === 'right') return ctx.accept();
      if (ctx.method === 'publickey' && !Array.isArray(clientPub) && !(clientPub instanceof Error)) {
        const ok = ctx.key.algo === clientPub.type && ctx.key.data.equals(clientPub.getPublicSSH());
        if (ok && (!ctx.signature || clientPub.verify(ctx.blob!, ctx.signature))) return ctx.accept();
      }
      ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acc, _rej, info) => {
          commands.push(info.command);
          const stream = acc();
          stream.write(INVENTORY);
          stream.exit(0);
          stream.end();
        });
      });
    });
    client.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const opts = () => ({ timeoutMs: 2000, concurrency: 1, port });
const pw = (password: string): Credential => ({ id: 'c1', name: 'pw', kind: 'ssh_password', username: 'discovery', secret: { password } });

describe('SshCollector', () => {
  it('collects inventory over password auth with one read-only exec, and fingerprints the host key', async () => {
    commands = [];
    const r = await new SshCollector().probe('127.0.0.1', pw('right'), opts());
    expect(r.kind).toBe('facts');
    if (r.kind !== 'facts') return;
    const parsed = utils.parseKey(hostKey.public);
    if (Array.isArray(parsed) || parsed instanceof Error) throw new Error('bad key');
    expect(r.facts).toMatchObject({ hostname: 'lab-01', serialNumber: 'ABC123', cpuCores: 8, sshHostKey: fingerprint(parsed.getPublicSSH()) });
    expect(commands).toHaveLength(1);
    // Read-only: no redirects other than stderr to /dev/null, no mutating commands.
    const script = commands[0].replace(/2>\/dev\/null/g, '');
    expect(script).not.toMatch(/>/);
    expect(script).not.toMatch(/\b(rm|mv|cp|tee|dd|chmod|chown|apt|yum|dnf|systemctl|reboot|shutdown)\b/);
  });

  it('authenticates with a private key', async () => {
    const r = await new SshCollector().probe('127.0.0.1', { id: 'c2', name: 'key', kind: 'ssh_key', username: 'discovery', secret: { privateKey: clientKey.private } }, opts());
    expect(r.kind).toBe('facts');
  });

  it('reports a rejected credential as auth_failed', async () => {
    expect(await new SshCollector().probe('127.0.0.1', pw('wrong'), opts())).toMatchObject({ kind: 'auth_failed' });
  });

  it('reports a peer that drops the connection during the handshake as unreachable, fast', async () => {
    const dropper = createServer((sock) => sock.destroy());
    await new Promise<void>((r) => dropper.listen(0, '127.0.0.1', r));
    const t0 = Date.now();
    const r = await new SshCollector().probe('127.0.0.1', pw('right'), { ...opts(), port: (dropper.address() as AddressInfo).port });
    await new Promise<void>((r2) => dropper.close(() => r2()));
    expect(r).toEqual({ kind: 'unreachable' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('reports a closed port as unreachable', async () => {
    const free = createServer();
    await new Promise<void>((r) => free.listen(0, '127.0.0.1', r));
    const closed = (free.address() as AddressInfo).port;
    await new Promise<void>((r) => free.close(() => r()));
    expect(await new SshCollector().probe('127.0.0.1', pw('right'), { ...opts(), port: closed })).toEqual({ kind: 'unreachable' });
  });
});
