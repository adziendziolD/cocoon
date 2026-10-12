import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TokenInfo } from '@cocoon/protocol';
import { notFound } from './errors.ts';
import { newId } from './ids.ts';
import type { Store, TokenRecord } from './store.ts';

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const LAST_USED_RESOLUTION_MS = 60_000;

/** API tokens. Only hashes are stored; an optional COCOON_TOKEN from the environment is always accepted too. */
export class TokenService {
  private readonly envHash?: Buffer;

  constructor(
    private readonly store: Store,
    envToken?: string,
  ) {
    if (envToken) this.envHash = sha256(envToken);
  }

  verify(provided: string | undefined): boolean {
    if (!provided) return false;
    const hash = sha256(provided);
    if (this.envHash && timingSafeEqual(hash, this.envHash)) return true;
    const record = this.store.tokens().find((t) => timingSafeEqual(Buffer.from(t.hash, 'hex'), hash));
    if (!record) return false;
    const now = Date.now();
    if (!record.lastUsedAt || now - Date.parse(record.lastUsedAt) > LAST_USED_RESOLUTION_MS) {
      record.lastUsedAt = new Date(now).toISOString();
      this.store.putToken(record);
    }
    return true;
  }

  list(): TokenInfo[] {
    return this.store.tokens().map(({ hash: _hash, ...info }) => info);
  }

  create(name: string): { token: string; info: TokenInfo } {
    const token = `cct_${randomBytes(24).toString('base64url')}`;
    const record: TokenRecord = {
      id: newId('tk'),
      name,
      hash: sha256(token).toString('hex'),
      preview: `${token.slice(0, 8)}…${token.slice(-4)}`,
      createdAt: new Date().toISOString(),
    };
    this.store.putToken(record);
    const { hash: _hash, ...info } = record;
    return { token, info };
  }

  revoke(id: string): void {
    if (!this.store.tokens().some((t) => t.id === id)) throw notFound('token', id);
    this.store.putToken({ id, delete: true });
  }

  /**
   * First start without COCOON_TOKEN: create an admin token and keep it in <dataDir>/admin-token.txt
   * so beginners can always find their login. Returns the token if one is available on disk.
   */
  ensureAdminToken(): string | undefined {
    const file = join(this.store.dataDir, 'admin-token.txt');
    if (!this.envHash && this.store.tokens().length === 0) {
      const { token } = this.create('Admin');
      writeFileSync(file, `${token}\n`, { mode: 0o600 });
      return token;
    }
    if (!existsSync(file)) return undefined;
    const token = readFileSync(file, 'utf8').trim();
    return this.verify(token) ? token : undefined;
  }
}
