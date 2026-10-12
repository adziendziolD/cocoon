import { KNOWN_SECRETS, type SecretInfo } from '@cocoon/protocol';
import type { Store } from './store.ts';

/** API keys and tokens never contain whitespace; copies from a wrapped terminal line often do. */
const isCredential = (name: string) => name in KNOWN_SECRETS || /(_KEY|_TOKEN)$/.test(name);
const normalize = (name: string, value: string) => (isCredential(name) ? value.replace(/\s+/g, '') : value.trim());

export const mask = (value: string) =>
  value.length <= 12 ? '••••' : `${value.slice(0, Math.min(7, value.length - 8))}…${value.slice(-4)}`;

/** Secrets (API keys, tokens) stored server-side; falls back to the process environment. */
export class SecretsService {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: Store) {}

  resolve(name: string): string | undefined {
    const value = this.store.secrets()[name]?.value ?? (process.env[name] || undefined);
    return value === undefined ? undefined : normalize(name, value);
  }

  list(): SecretInfo[] {
    const stored = this.store.secrets();
    const names = new Set([...Object.keys(KNOWN_SECRETS), ...Object.keys(stored)]);
    return [...names].map((name) => this.info(name));
  }

  set(name: string, value: string): SecretInfo {
    this.store.putSecret(name, { value: normalize(name, value), updatedAt: new Date().toISOString() });
    this.changed();
    return this.info(name);
  }

  delete(name: string): void {
    this.store.putSecret(name, undefined);
    this.changed();
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private info(name: string): SecretInfo {
    const stored = this.store.secrets()[name];
    if (stored) return { name, set: true, preview: mask(stored.value), source: 'store', updatedAt: stored.updatedAt };
    const env = process.env[name];
    if (env) return { name, set: true, preview: mask(env), source: 'env' };
    return { name, set: false };
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}
