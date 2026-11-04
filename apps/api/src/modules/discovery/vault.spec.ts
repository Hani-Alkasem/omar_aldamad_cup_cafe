import { randomBytes } from 'node:crypto';
import { Vault, VaultError } from './vault';

const key = () => randomBytes(32).toString('base64');
const aad = { id: '6f1c1f0e-0000-4000-8000-000000000001', kind: 'ssh_password' };

describe('Vault', () => {
  it('round-trips and uses a fresh IV every time', () => {
    const v = new Vault({ VAULT_MASTER_KEY: key() });
    const a = v.seal({ password: 'hunter2' }, aad);
    const b = v.seal({ password: 'hunter2' }, aad);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.toString('utf8')).not.toContain('hunter2');
    expect(v.open(a, aad)).toEqual({ password: 'hunter2' });
  });

  it('refuses ciphertext moved to another row or kind', () => {
    const v = new Vault({ VAULT_MASTER_KEY: key() });
    const s = v.seal({ password: 'x' }, aad);
    expect(() => v.open(s, { ...aad, id: '6f1c1f0e-0000-4000-8000-000000000002' })).toThrow(VaultError);
    expect(() => v.open(s, { ...aad, kind: 'ssh_key' })).toThrow(VaultError);
  });

  it('detects tampering', () => {
    const v = new Vault({ VAULT_MASTER_KEY: key() });
    const s = v.seal({ password: 'x' }, aad);
    s.ciphertext[0] ^= 1;
    expect(() => v.open(s, aad)).toThrow(VaultError);
  });

  it('reads rows sealed with a previous key during rotation', () => {
    const oldKey = key();
    const sealed = new Vault({ VAULT_MASTER_KEY: oldKey }).seal({ community: 'public' }, aad);
    expect(() => new Vault({ VAULT_MASTER_KEY: key() }).open(sealed, aad)).toThrow(/unknown key/);
    expect(new Vault({ VAULT_MASTER_KEY: key(), VAULT_PREVIOUS_KEYS: oldKey }).open(sealed, aad)).toEqual({ community: 'public' });
  });

  it('rejects short keys at startup', () => {
    expect(() => new Vault({ VAULT_MASTER_KEY: randomBytes(16).toString('base64') })).toThrow(/32 random bytes/);
    expect(() => new Vault({})).toThrow(/required/);
  });
});
