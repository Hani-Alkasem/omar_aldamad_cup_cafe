import { createHash } from 'node:crypto';
import type { DiscoveryOptions } from '@itam/shared';
import { Client, type ConnectConfig } from 'ssh2';
import { INVENTORY_SCRIPT, parseInventory } from './ssh-inventory';
import type { Collector, Credential, ProbeResult } from './types';

const MAX_OUTPUT = 512 * 1024;
const UNREACHABLE = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTDOWN']);

/** OpenSSH-style fingerprint: SHA256:<base64 without padding>. */
export const fingerprint = (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

export class SshCollector implements Collector {
  probe(ip: string, cred: Credential, opts: DiscoveryOptions): Promise<ProbeResult> {
    if (cred.kind !== 'ssh_password' && cred.kind !== 'ssh_key') return Promise.resolve({ kind: 'error', message: `${cred.kind} is not an SSH credential` });

    return new Promise<ProbeResult>((resolve) => {
      const conn = new Client();
      let hostKey: string | undefined;
      let settled = false;
      const done = (r: ProbeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(hard);
        conn.end();
        resolve(r);
      };
      // readyTimeout covers the handshake only; this bounds the whole probe including the command.
      const hard = setTimeout(() => done({ kind: 'error', message: `no result within ${opts.timeoutMs * 4} ms` }), opts.timeoutMs * 4);

      const config: ConnectConfig = {
        host: ip,
        port: opts.port ?? 22,
        username: cred.username ?? '',
        readyTimeout: opts.timeoutMs,
        keepaliveInterval: 0,
        // Record the key; the API compares it with the asset's last known key (TOFU with change alerts).
        hostVerifier: (key: Buffer) => {
          hostKey = fingerprint(key);
          return true;
        },
        // Never fall back to keyboard-interactive prompts or agents on the worker host.
        tryKeyboard: false,
        agent: undefined,
      };
      if (cred.kind === 'ssh_password') config.password = cred.secret.password;
      else {
        config.privateKey = cred.secret.privateKey;
        if (cred.secret.passphrase) config.passphrase = cred.secret.passphrase;
      }

      conn.on('error', (err: Error & { level?: string; code?: string }) => {
        if (err.level === 'client-authentication') return done({ kind: 'auth_failed', message: 'credential rejected' });
        if (err.level === 'client-timeout' || (err.code && UNREACHABLE.has(err.code)) || /before handshake/i.test(err.message)) return done({ kind: 'unreachable' });
        done({ kind: 'error', message: err.message.slice(0, 300) });
      });

      // A peer that drops the TCP connection mid-handshake emits only 'close'.
      let ready = false;
      conn.on('close', () => {
        if (!ready) done({ kind: 'unreachable' });
      });

      conn.on('ready', () => {
        ready = true;
        conn.exec(INVENTORY_SCRIPT, (err, stream) => {
          if (err) return done({ kind: 'error', message: `exec failed: ${err.message}` });
          let out = '';
          stream.on('data', (d: Buffer) => {
            if (out.length < MAX_OUTPUT) out += d.toString('utf8');
          });
          stream.stderr.on('data', () => undefined);
          stream.on('close', () => {
            if (!out.includes('@@end')) return done({ kind: 'error', message: 'inventory script did not complete (restricted shell?)' });
            done({ kind: 'facts', facts: parseInventory(ip, out, hostKey) });
          });
        });
      });

      conn.connect(config);
    });
  }
}
