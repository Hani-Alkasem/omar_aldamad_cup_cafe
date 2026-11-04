/** The parts of net-snmp 3.x this worker uses (the package ships no types). */
declare module 'net-snmp' {
  export interface Varbind {
    oid: string;
    type: number;
    value: unknown;
  }
  export interface Session {
    get(oids: string[], cb: (error: Error | null, varbinds: Varbind[]) => void): void;
    subtree(oid: string, maxRepetitions: number, feed: (varbinds: Varbind[]) => boolean | void, done: (error: Error | null) => void): void;
    close(): void;
    on(event: 'error', cb: (e: Error) => void): void;
  }
  export interface SessionOptions {
    port?: number;
    retries?: number;
    timeout?: number;
    version?: number;
    transport?: 'udp4' | 'udp6';
    idBitsSize?: 16 | 32;
  }
  export interface V3User {
    name: string;
    level: number;
    authProtocol?: number;
    authKey?: string;
    privProtocol?: number;
    privKey?: string;
  }
  export const Version1: number;
  export const Version2c: number;
  export const Version3: number;
  export const SecurityLevel: { noAuthNoPriv: number; authNoPriv: number; authPriv: number };
  export const AuthProtocols: { none: number; md5: number; sha: number; sha224: number; sha256: number; sha384: number; sha512: number };
  export const PrivProtocols: { none: number; des: number; aes: number; aes256b: number; aes256r: number };
  export const ObjectType: Record<string, number>;
  export const MibProviderType: { Scalar: string; Table: string };
  export const MaxAccess: Record<string, number>;
  export function createSession(target: string, community: string, options?: SessionOptions): Session;
  export function createV3Session(target: string, user: V3User, options?: SessionOptions): Session;
  export function isVarbindError(vb: Varbind): boolean;
  export function createAgent(options: Record<string, unknown>, cb: (error: Error | null, data: unknown) => void, mib?: unknown): Agent;
  export interface Agent {
    getMib(): Mib;
    getAuthorizer(): { addCommunity(c: string): void; addUser(u: V3User): void };
    close(cb?: () => void): void;
  }
  export interface Mib {
    registerProvider(p: Record<string, unknown>): void;
    setScalarValue(name: string, value: unknown): void;
    addTableRow(name: string, row: unknown[]): void;
  }
}
