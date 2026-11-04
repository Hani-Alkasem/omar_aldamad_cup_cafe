import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';

/**
 * Outbound HTTP for webhooks, hardened against SSRF:
 * - only public unicast addresses, unless an operator allow-lists CIDRs (on-prem Jira, a lab receiver);
 * - the address check happens inside the socket's DNS lookup, so the vetted IP is the one dialled
 *   (no DNS-rebinding window), while Host and TLS SNI keep the original hostname;
 * - redirects are never followed; bodies are capped; every request has a hard timeout.
 */

export class ForbiddenAddressError extends Error {}

export function parseAllowList(text: string | undefined): Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> {
  return (text ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((c) => ipaddr.parseCIDR(c));
}

export function isAllowedAddress(ip: string, allow: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]> = []): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip); // unwraps ::ffff:10.0.0.1
  } catch {
    return false;
  }
  if (allow.some(([net, bits]) => net.kind() === addr.kind() && addr.match(net, bits))) return true;
  return addr.range() === 'unicast';
}

export interface SafeResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  ms: number;
}

export interface SafeRequest {
  url: string;
  method?: 'POST' | 'GET';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  allow?: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]>;
  allowHttp?: boolean;
}

export function safeRequest(req: SafeRequest): Promise<SafeResponse> {
  const u = new URL(req.url);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && req.allowHttp)) return Promise.reject(new ForbiddenAddressError(`${u.protocol} is not allowed; use https`));
  if (u.username || u.password) return Promise.reject(new ForbiddenAddressError('credentials in the URL are not allowed'));
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !isAllowedAddress(host, req.allow)) return Promise.reject(new ForbiddenAddressError(`${host} is not a public address`));

  const lookup = (hostname: string, options: object, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err, '');
      const ok = addrs.find((a) => isAllowedAddress(a.address, req.allow));
      if (!ok) return cb(new ForbiddenAddressError(`${hostname} resolves only to non-public addresses (${addrs.map((a) => a.address).join(', ')})`), '');
      if ((options as { all?: boolean }).all) return cb(null, [ok]);
      cb(null, ok.address, ok.family);
    });
  };

  const started = Date.now();
  const maxBytes = req.maxBytes ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    const r = (u.protocol === 'https:' ? https : http).request(
      u,
      { method: req.method ?? 'POST', headers: { 'user-agent': 'ITAM-Webhooks/1', ...req.headers }, lookup: lookup as never, timeout: req.timeoutMs ?? 10_000 },
      (res) => {
        let body = '';
        let size = 0;
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          size += Buffer.byteLength(chunk);
          if (size <= maxBytes) body += chunk;
          else res.destroy();
        });
        res.on('close', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, ms: Date.now() - started }));
        res.on('error', reject);
      },
    );
    r.on('timeout', () => r.destroy(new Error(`no response within ${req.timeoutMs ?? 10_000} ms`)));
    r.on('error', reject);
    r.end(req.body);
  });
}
