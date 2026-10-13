import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PREFIX = 'v1';

/**
 * Encrypts environment values at rest (AES-256-GCM). The key lives in its own file (0600) next to the state file, so a copy
 * of state.json alone (backup, support bundle, accidental commit) does not reveal the values. Every value is bound to its
 * place ("workspace:ws_1/STRIPE_KEY") – a blob moved to another variable or level does not decrypt.
 */
export class EnvVault {
  private key?: Buffer;

  constructor(private readonly keyFile: string) {}

  static in(dataDir: string): EnvVault {
    return new EnvVault(join(dataDir, 'env.key'));
  }

  encrypt(context: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.loadKey(true), iv);
    cipher.setAAD(Buffer.from(context));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  /** Returns undefined if the blob is damaged, belongs elsewhere or the key is gone. */
  decrypt(context: string, blob: string): string | undefined {
    const [prefix, iv, tag, data] = blob.split(':');
    if (prefix !== PREFIX || !iv || !tag || data === undefined) return undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.loadKey(false), Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      return undefined;
    }
  }

  private loadKey(create: boolean): Buffer {
    if (this.key) return this.key;
    if (existsSync(this.keyFile)) {
      this.key = Buffer.from(readFileSync(this.keyFile, 'utf8').trim(), 'base64');
    } else if (create) {
      this.key = randomBytes(32);
      writeFileSync(this.keyFile, this.key.toString('base64'), { mode: 0o600, flag: 'wx' });
      chmodSync(this.keyFile, 0o600);
    } else {
      throw new Error('no key');
    }
    if (this.key.length !== 32) {
      this.key = undefined;
      throw new Error('invalid key file');
    }
    return this.key;
  }
}
