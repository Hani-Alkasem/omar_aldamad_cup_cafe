import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyId: string;
}

/** Thrown when a row cannot be opened: wrong key, tampered bytes, or ciphertext moved between rows. */
export class VaultError extends Error {}

const keyIdOf = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 16);

function parseKey(name: string, b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error(`${name} must be 32 random bytes, base64-encoded (openssl rand -base64 32)`);
  return key;
}

/**
 * AES-256-GCM envelope for discovery credentials.
 *
 * - The master key lives only in the API's environment (or a KMS-injected env var); the database
 *   holds ciphertext, a random 96-bit IV and the 128-bit auth tag.
 * - AAD binds each ciphertext to its row id and kind, so copying a sealed blob onto another row
 *   (or changing the kind) makes decryption fail instead of handing out the wrong secret.
 * - `key_id` records which key sealed the row. Old keys stay readable via VAULT_PREVIOUS_KEYS
 *   (comma-separated) while `reseal` moves rows to the current key.
 */
@Injectable()
export class Vault {
  private readonly current: Buffer;
  private readonly currentId: string;
  private readonly keys = new Map<string, Buffer>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    if (!env.VAULT_MASTER_KEY) throw new Error('VAULT_MASTER_KEY is required (openssl rand -base64 32)');
    this.current = parseKey('VAULT_MASTER_KEY', env.VAULT_MASTER_KEY);
    this.currentId = keyIdOf(this.current);
    this.keys.set(this.currentId, this.current);
    for (const old of (env.VAULT_PREVIOUS_KEYS ?? '').split(',').filter(Boolean)) {
      const k = parseKey('VAULT_PREVIOUS_KEYS entry', old.trim());
      this.keys.set(keyIdOf(k), k);
    }
  }

  get keyId() {
    return this.currentId;
  }

  seal(plaintext: object, aad: { id: string; kind: string }): Sealed {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.current, iv);
    cipher.setAAD(Buffer.from(`${aad.id}:${aad.kind}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext), 'utf8'), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag(), keyId: this.currentId };
  }

  open<T = unknown>(sealed: Sealed, aad: { id: string; kind: string }): T {
    const key = this.keys.get(sealed.keyId);
    if (!key) throw new VaultError(`credential sealed with unknown key ${sealed.keyId}; add it to VAULT_PREVIOUS_KEYS`);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
      decipher.setAAD(Buffer.from(`${aad.id}:${aad.kind}`));
      decipher.setAuthTag(sealed.tag);
      const text = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
      return JSON.parse(text) as T;
    } catch {
      throw new VaultError('credential could not be decrypted (tampered, moved, or wrong key)');
    }
  }
}
