import type { DiscoveryOptions, HostFacts } from '@itam/shared';
import snmp from 'net-snmp';
import { cleanSerial, type Collector, type Credential, type ProbeResult } from './types';

export const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectID: '1.3.6.1.2.1.1.2.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifPhysAddress: '1.3.6.1.2.1.2.2.1.6',
  ifSpeed: '1.3.6.1.2.1.2.2.1.5',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  entPhysicalClass: '1.3.6.1.2.1.47.1.1.1.1.5',
  entPhysicalMfgName: '1.3.6.1.2.1.47.1.1.1.1.12',
  entPhysicalModelName: '1.3.6.1.2.1.47.1.1.1.1.13',
  entPhysicalSerialNum: '1.3.6.1.2.1.47.1.1.1.1.11',
} as const;

/** IANA enterprise numbers → vendor, from sysObjectID 1.3.6.1.4.1.<n>. */
const ENTERPRISES: Record<string, string> = {
  '9': 'Cisco', '11': 'HPE', '43': '3Com', '318': 'APC', '674': 'Dell', '789': 'NetApp', '2011': 'Huawei', '2636': 'Juniper',
  '3375': 'F5', '4526': 'Netgear', '6027': 'Dell EMC Networking', '6876': 'VMware', '8072': 'Net-SNMP', '12356': 'Fortinet',
  '14988': 'MikroTik', '25461': 'Palo Alto Networks', '30065': 'Arista', '47196': 'Aruba', '534': 'Eaton', '13742': 'Raritan',
};

const MAX_INTERFACES = 1024;
const CHASSIS = 3;

const text = (v: unknown) => (Buffer.isBuffer(v) ? v.toString('utf8').replace(/\0+$/, '').trim() : v == null ? undefined : String(v).trim()) || undefined;
const macOf = (v: unknown) => {
  if (!Buffer.isBuffer(v) || v.length !== 6) return undefined;
  const m = [...v].map((b) => b.toString(16).padStart(2, '0')).join(':');
  return m === '00:00:00:00:00:00' ? undefined : m;
};
const index = (oid: string, base: string) => oid.slice(base.length + 1);

const AUTH = { md5: 'md5', sha: 'sha', sha256: 'sha256', sha512: 'sha512' } as const;
const PRIV = { des: 'des', aes: 'aes', aes256: 'aes256b' } as const;

function session(ip: string, cred: Credential, opts: DiscoveryOptions): snmp.Session {
  const options: snmp.SessionOptions = {
    port: opts.port ?? 161,
    retries: 1,
    timeout: opts.timeoutMs,
    transport: ip.includes(':') ? 'udp6' : 'udp4',
    idBitsSize: 32,
  };
  if (cred.kind === 'snmp_v2c') return snmp.createSession(ip, cred.secret.community, { ...options, version: snmp.Version2c });
  if (cred.kind !== 'snmp_v3') throw new Error(`${cred.kind} is not an SNMP credential`);
  return snmp.createV3Session(ip, {
    name: cred.username ?? '',
    level: snmp.SecurityLevel.authPriv,
    authProtocol: snmp.AuthProtocols[AUTH[cred.secret.authProtocol]],
    authKey: cred.secret.authKey,
    privProtocol: snmp.PrivProtocols[PRIV[cred.secret.privProtocol]],
    privKey: cred.secret.privKey,
  }, options);
}

const get = (s: snmp.Session, oids: string[]) =>
  new Promise<snmp.Varbind[]>((resolve, reject) => s.get(oids, (e, vbs) => (e ? reject(e) : resolve(vbs))));

/** Walk a column; a missing MIB is an empty table, not a failure. */
const walk = (s: snmp.Session, oid: string, limit = MAX_INTERFACES) =>
  new Promise<Map<string, unknown>>((resolve) => {
    const rows = new Map<string, unknown>();
    s.subtree(
      oid,
      25,
      (vbs) => {
        for (const vb of vbs) if (!snmp.isVarbindError(vb)) rows.set(index(vb.oid, oid), vb.value);
        return rows.size >= limit; // true stops the walk
      },
      () => resolve(rows),
    );
  });

function classify(err: Error): ProbeResult {
  if (err.name === 'RequestTimedOutError') return { kind: 'unreachable' };
  if (/usm|auth|digest|decrypt|unknown.*(user|engine)|wrong.*password/i.test(err.message)) return { kind: 'auth_failed', message: 'SNMPv3 credential rejected' };
  return { kind: 'error', message: err.message.slice(0, 300) };
}

export class SnmpCollector implements Collector {
  async probe(ip: string, cred: Credential, opts: DiscoveryOptions): Promise<ProbeResult> {
    let s: snmp.Session;
    try {
      s = session(ip, cred, opts);
    } catch (e) {
      return { kind: 'error', message: (e as Error).message };
    }
    s.on('error', () => undefined);
    try {
      const sys = await get(s, [OID.sysDescr, OID.sysObjectID, OID.sysName]);
      const [descr, objectId, name] = sys.map((vb) => (snmp.isVarbindError(vb) ? undefined : vb.value));
      if (descr === undefined && objectId === undefined) return { kind: 'error', message: 'agent answered without the system group' };

      const [ifDescr, ifName, ifMac, ifSpeed, ifHigh] = await Promise.all([
        walk(s, OID.ifDescr), walk(s, OID.ifName), walk(s, OID.ifPhysAddress), walk(s, OID.ifSpeed), walk(s, OID.ifHighSpeed),
      ]);
      const interfaces: HostFacts['interfaces'] = [];
      for (const [idx, d] of ifDescr) {
        const name = text(ifName.get(idx)) ?? text(d);
        if (!name) continue;
        const high = Number(ifHigh.get(idx));
        const low = Number(ifSpeed.get(idx));
        const speed = high > 0 ? high : low > 0 && low < 4_294_967_295 ? Math.round(low / 1e6) : 0;
        const mac = macOf(ifMac.get(idx));
        interfaces.push({ name: name.slice(0, 64), ...(mac ? { mac } : {}), ...(speed > 0 ? { speedMbps: speed } : {}) });
      }

      // ENTITY-MIB: the chassis row carries the box's serial and model.
      const classes = await walk(s, OID.entPhysicalClass, 512);
      const chassis = [...classes].find(([, c]) => Number(c) === CHASSIS)?.[0];
      let serialNumber: string | undefined;
      let model: string | undefined;
      let mfg: string | undefined;
      if (chassis) {
        const vbs = await get(s, [`${OID.entPhysicalSerialNum}.${chassis}`, `${OID.entPhysicalModelName}.${chassis}`, `${OID.entPhysicalMfgName}.${chassis}`]).catch(() => []);
        [serialNumber, model, mfg] = vbs.map((vb) => (snmp.isVarbindError(vb) ? undefined : text(vb.value)));
      }

      const sysObjectId = objectId ? String(objectId) : undefined;
      const enterprise = sysObjectId && /^1\.3\.6\.1\.4\.1\.(\d+)/.exec(sysObjectId)?.[1];
      return {
        kind: 'facts',
        facts: {
          ip,
          protocol: 'snmp',
          hostname: text(name),
          sysDescr: text(descr)?.slice(0, 1024),
          ...(sysObjectId ? { sysObjectId } : {}),
          vendor: mfg ?? (enterprise ? ENTERPRISES[enterprise] : undefined),
          model,
          serialNumber: cleanSerial(serialNumber),
          disks: [],
          interfaces,
        },
      };
    } catch (e) {
      return classify(e as Error);
    } finally {
      s.close();
    }
  }
}
