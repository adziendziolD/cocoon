import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityLog } from '../activity.ts';
import { EventBus } from '../events.ts';
import { Store } from '../store.ts';
import { TokenService } from '../tokens.ts';
import { PasswordHasher, type ScryptCost } from './password.ts';
import type { Principal } from './principal.ts';
import { DEFAULT_THROTTLE, LoginThrottle } from './throttle.ts';
import { AuthService, clientKey, type AuthOptions } from './users.ts';

/** Cheap scrypt parameters keep the tests fast. */
const CHEAP: ScryptCost = { N: 2 ** 10, r: 8, p: 1 };
const HOUR = 3_600_000;
const OPTIONS: AuthOptions = { sessionIdleMs: 8 * HOUR, sessionMaxMs: 7 * 24 * HOUR };
const PASSWORD = 'three small clouds over the harbour';
const OTHER_PASSWORD = 'seven brave owls in the library';
const ADMIN_TOKEN = 'a-long-random-admin-token-for-tests';
const admin: Principal = { kind: 'token', role: 'admin', credentialId: 'token:env', name: 'COCOON_TOKEN' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cocoon-auth-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A counting hasher: tells how many hashes an operation cost. */
class CountingHasher extends PasswordHasher {
  verifies = 0;
  override verify(password: string, encoded: string) {
    this.verifies++;
    return super.verify(password, encoded);
  }
}

function setup(options: { cost?: ScryptCost; hasher?: PasswordHasher } = {}) {
  let time = Date.parse('2026-03-01T08:00:00Z');
  const clock = { now: () => time, advance: (ms: number) => void (time += ms) };
  const store = new Store(dir);
  const tokens = new TokenService(store, ADMIN_TOKEN);
  const activity = new ActivityLog(new EventBus());
  const logs: string[] = [];
  const build = (store: Store, tokens: TokenService, hasher: PasswordHasher) =>
    new AuthService(store, tokens, activity, OPTIONS, {
      hasher,
      throttle: new LoginThrottle(DEFAULT_THROTTLE, clock.now),
      now: clock.now,
      log: (message) => logs.push(message),
    });
  const hasher = options.hasher ?? new PasswordHasher(options.cost ?? CHEAP);
  const auth = build(store, tokens, hasher);
  const revoked: string[] = [];
  auth.onRevoked((id) => revoked.push(id));
  return { auth, store, tokens, activity, clock, revoked, logs, hasher, build };
}
type Setup = ReturnType<typeof setup>;

/** Invites a user and lets them choose a password: returns the user id and their session. */
async function register(s: Setup, username = 'alice', role: 'admin' | 'member' = 'member', password = PASSWORD) {
  const { user, setup } = s.auth.createUser({ username, role });
  const session = await s.auth.completeSetup(setup.token, password, '203.0.113.1');
  return { id: user.id, session, token: session.token };
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
};
const asyncCodeOf = async (promise: Promise<unknown>): Promise<{ code?: string; message?: string }> => {
  try {
    await promise;
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  }
  return {};
};

describe('inviting users', () => {
  it('creates a user without a password and a one-time link token, and logs it in the activity feed', () => {
    const { auth, store, activity } = setup();
    const { user, setup: link } = auth.createUser({ username: 'Alice', displayName: 'Alice Example', role: 'member' });
    expect(user).toMatchObject({ username: 'alice', displayName: 'Alice Example', role: 'member', status: 'invited', sessions: 0 });
    expect(user.setupExpiresAt).toBe(link.expiresAt);
    expect(link.token).toMatch(/^ccu_/);
    expect(Date.parse(link.expiresAt) - Date.parse('2026-03-01T08:00:00Z')).toBe(72 * HOUR);
    // Only the hash of the token is kept.
    expect(JSON.stringify(store.users())).not.toContain(link.token);
    expect(activity.list(5, 'en')[0]?.message).toBe('User "alice" created');
  });

  it('keeps usernames unique regardless of case', () => {
    const { auth } = setup();
    auth.createUser({ username: 'alice', role: 'member' });
    expect(codeOf(() => auth.createUser({ username: 'ALICE', role: 'admin' }))).toBe('conflict');
  });

  it('lists users by name with their status', async () => {
    const s = setup();
    await register(s, 'bob');
    s.auth.createUser({ username: 'alice', role: 'admin' });
    expect(s.auth.listUsers().map((u) => [u.username, u.status, u.role])).toEqual([
      ['alice', 'invited', 'admin'],
      ['bob', 'active', 'member'],
    ]);
  });
});

describe('choosing a password with the link', () => {
  it('names the account for the link', () => {
    const { auth } = setup();
    const { setup: link } = auth.createUser({ username: 'alice', displayName: 'Alice', role: 'member' });
    expect(auth.setupInfo(link.token, '203.0.113.1')).toEqual({ username: 'alice', displayName: 'Alice' });
  });

  it('signs the user in and makes the link single-use', async () => {
    const { auth, store } = setup();
    const { user, setup: link } = auth.createUser({ username: 'alice', role: 'member' });
    const session = await auth.completeSetup(link.token, PASSWORD, '203.0.113.1');
    expect(session.token).toMatch(/^ccs_/);
    expect(session.identity).toMatchObject({ kind: 'user', role: 'member', user: { id: user.id, username: 'alice' } });
    expect(auth.listUsers()[0]).toMatchObject({ status: 'active', sessions: 1 });
    expect(auth.listUsers()[0]?.setupExpiresAt).toBeUndefined();
    expect(store.user(user.id)?.passwordHash).toMatch(/^\$scrypt\$/);
    expect(await asyncCodeOf(auth.completeSetup(link.token, OTHER_PASSWORD, '203.0.113.1'))).toMatchObject({ code: 'unauthorized' });
    expect(codeOf(() => auth.setupInfo(link.token, '203.0.113.1'))).toBe('unauthorized');
  });

  it('explains a weak password and keeps the link usable', async () => {
    const { auth } = setup();
    const { setup: link } = auth.createUser({ username: 'alice', role: 'member' });
    for (const weak of ['short', 'Password1234', 'my-alice-password']) {
      expect((await asyncCodeOf(auth.completeSetup(link.token, weak, '203.0.113.1'))).code, weak).toBe('bad_request');
    }
    expect(auth.setupInfo(link.token, '203.0.113.1').username).toBe('alice');
    await expect(auth.completeSetup(link.token, PASSWORD, '203.0.113.1')).resolves.toBeDefined();
  });

  it('stops working after 72 hours', () => {
    const { auth, clock } = setup();
    const { setup: link } = auth.createUser({ username: 'alice', role: 'member' });
    clock.advance(71 * HOUR);
    expect(auth.setupInfo(link.token, '203.0.113.1').username).toBe('alice');
    clock.advance(2 * HOUR);
    expect(codeOf(() => auth.setupInfo(link.token, '203.0.113.1'))).toBe('unauthorized');
  });

  it('does not work for wrong tokens, and slows down whoever guesses', () => {
    const { auth } = setup();
    auth.createUser({ username: 'alice', role: 'member' });
    for (let i = 0; i < 20; i++) expect(codeOf(() => auth.setupInfo(`ccu_guess${i}`, '198.51.100.9'))).toBe('unauthorized');
    expect(codeOf(() => auth.setupInfo('ccu_guess21', '198.51.100.9'))).toBe('rate_limited');
    // Another address is not affected.
    expect(codeOf(() => auth.setupInfo('ccu_guess21', '198.51.100.10'))).toBe('unauthorized');
  });

  it('does not work for a disabled user', () => {
    const { auth } = setup();
    const { user, setup: link } = auth.createUser({ username: 'alice', role: 'member' });
    auth.updateUser(admin, { userId: user.id, disabled: true });
    expect(codeOf(() => auth.setupInfo(link.token, '203.0.113.1'))).toBe('unauthorized');
  });
});

describe('signing in', () => {
  it('accepts the right password, in any spelling of the name, and remembers the time', async () => {
    const s = setup();
    const { id } = await register(s);
    s.clock.advance(HOUR);
    const result = await s.auth.login('  Alice ', PASSWORD, '203.0.113.1');
    expect(result.identity.user?.username).toBe('alice');
    expect(s.store.user(id)?.lastLoginAt).toBe('2026-03-01T09:00:00.000Z');
    expect(Date.parse(result.expiresAt)).toBe(s.clock.now() + OPTIONS.sessionMaxMs);
  });

  it('gives a session token that works like an API token and says who it is', async () => {
    const s = setup();
    const { id, token } = await register(s, 'alice', 'member');
    expect(s.auth.authenticate(token)).toMatchObject({ kind: 'user', role: 'member', userId: id, username: 'alice' });
    expect(s.auth.authenticate(`${token}x`)).toBeUndefined();
    expect(s.auth.authenticate(undefined)).toBeUndefined();
    expect(s.auth.authenticate('')).toBeUndefined();
  });

  it('answers wrong password, unknown name, pending invitation and disabled user in the same way', async () => {
    const s = setup();
    const { id } = await register(s, 'alice');
    s.auth.createUser({ username: 'pending', role: 'member' });
    await register(s, 'locked');
    s.auth.updateUser(admin, { userId: s.auth.listUsers().find((u) => u.username === 'locked')!.id, disabled: true });
    const answers = await Promise.all([
      asyncCodeOf(s.auth.login('alice', 'not the password at all', '203.0.113.1')),
      asyncCodeOf(s.auth.login('nobody', PASSWORD, '203.0.113.2')),
      asyncCodeOf(s.auth.login('pending', PASSWORD, '203.0.113.3')),
      asyncCodeOf(s.auth.login('locked', PASSWORD, '203.0.113.4')),
    ]);
    expect(new Set(answers.map((a) => a.code))).toEqual(new Set(['unauthorized']));
    expect(new Set(answers.map((a) => a.message)).size).toBe(1);
    expect(id).toBeDefined();
  });

  it('spends one hash on every attempt, whether or not the name exists', async () => {
    const hasher = new CountingHasher(CHEAP);
    const s = setup({ hasher });
    await register(s, 'alice');
    s.auth.createUser({ username: 'pending', role: 'member' });
    const base = hasher.verifies;
    await asyncCodeOf(s.auth.login('alice', 'wrong password, long enough', '203.0.113.1'));
    expect(hasher.verifies - base).toBe(1);
    await asyncCodeOf(s.auth.login('nobody', 'wrong password, long enough', '203.0.113.2'));
    expect(hasher.verifies - base).toBe(2);
    await asyncCodeOf(s.auth.login('pending', 'wrong password, long enough', '203.0.113.3'));
    expect(hasher.verifies - base).toBe(3);
  });

  it('recovers when the decoy hash for unknown names could not be made the first time', async () => {
    class FlakyHasher extends PasswordHasher {
      failNext = true;
      override hash(password: string) {
        if (!this.failNext) return super.hash(password);
        this.failNext = false;
        return Promise.reject(Object.assign(new Error('busy'), { code: 'rate_limited' }));
      }
    }
    const s = setup({ hasher: new FlakyHasher(CHEAP) });
    expect((await asyncCodeOf(s.auth.login('nobody', 'wrong password, long enough', '203.0.113.1'))).code).toBe('rate_limited');
    // Not stuck: the next unknown name is answered like any wrong password.
    expect((await asyncCodeOf(s.auth.login('nobody', 'wrong password, long enough', '203.0.113.2'))).code).toBe('unauthorized');
    expect((await asyncCodeOf(s.auth.login('nobody', 'wrong password, long enough', '203.0.113.3'))).code).toBe('unauthorized');
  });

  it('logs failures without the typed name, which is often a password in the wrong field', async () => {
    const s = setup();
    await register(s, 'alice');
    await asyncCodeOf(s.auth.login('my-secret-password-1', 'whatever the password is', '203.0.113.1'));
    await asyncCodeOf(s.auth.login('alice', 'whatever the password is', '203.0.113.1'));
    expect(s.logs).toHaveLength(2);
    expect(s.logs.join('\n')).not.toContain('my-secret-password-1');
    expect(s.logs.join('\n')).not.toContain('alice');
    expect(s.logs[0]).toBe('sign-in failed (unknown name)');
    expect(s.logs[1]).toMatch(/^sign-in failed \(user us_/);
  });

  it('locks the account after repeated wrong passwords, even for the right one, and releases it later', async () => {
    const s = setup();
    await register(s, 'alice');
    for (let i = 0; i < 5; i++) expect((await asyncCodeOf(s.auth.login('alice', `wrong password ${i} xxxx`, `203.0.113.${i + 1}`))).code).toBe('unauthorized');
    const locked = await asyncCodeOf(s.auth.login('alice', PASSWORD, '203.0.113.50'));
    expect(locked.code).toBe('rate_limited');
    s.clock.advance(31_000);
    await expect(s.auth.login('alice', PASSWORD, '203.0.113.50')).resolves.toBeDefined();
  });

  it('counts attempts that arrive at the same time, so parallel guesses do not get past the lock', async () => {
    const s = setup();
    await register(s, 'alice');
    const attempts = await Promise.all(Array.from({ length: 30 }, (_, i) => asyncCodeOf(s.auth.login('alice', `parallel guess number ${i}`, `203.0.113.${i + 1}`))));
    expect(attempts.filter((a) => a.code === 'unauthorized')).toHaveLength(5);
    expect(attempts.filter((a) => a.code === 'rate_limited')).toHaveLength(25);
  });

  it('does not charge the address for a correct password', async () => {
    const s = setup();
    await register(s, 'alice');
    for (let i = 0; i < 40; i++) await s.auth.login('alice', PASSWORD, '203.0.113.9');
    await expect(s.auth.login('alice', PASSWORD, '203.0.113.9')).resolves.toBeDefined();
  });

  it('puts the wait into the error, for the Retry-After header', async () => {
    const s = setup();
    await register(s, 'alice');
    for (let i = 0; i < 5; i++) await asyncCodeOf(s.auth.login('alice', `wrong password ${i} xxxx`, '203.0.113.1'));
    await s.auth.login('alice', PASSWORD, '203.0.113.2').catch((err: { details?: unknown }) => expect(err.details).toEqual({ retryAfterSeconds: 30 }));
  });

  it('stops one address from trying one password on many accounts', async () => {
    const s = setup();
    for (let i = 0; i < 20; i++) await asyncCodeOf(s.auth.login(`user${i}`, 'spring2026spring2026', '198.51.100.9'));
    expect((await asyncCodeOf(s.auth.login('user99', 'spring2026spring2026', '198.51.100.9'))).code).toBe('rate_limited');
    expect((await asyncCodeOf(s.auth.login('user99', 'spring2026spring2026', '198.51.100.10'))).code).toBe('unauthorized');
  });

  it('counts the addresses of one IPv6 network as one client', async () => {
    const s = setup();
    for (let i = 0; i < 20; i++) await asyncCodeOf(s.auth.login(`user${i}`, 'spring2026spring2026', `2001:db8:1:2:${i}::1`));
    expect((await asyncCodeOf(s.auth.login('user99', 'spring2026spring2026', '2001:db8:1:2:ffff::7'))).code).toBe('rate_limited');
  });

  it('renews hashes that were made with cheaper parameters', async () => {
    const s = setup();
    const { id } = await register(s, 'alice');
    expect(s.store.user(id)?.passwordHash).toContain('ln=10,');
    const stronger = s.build(s.store, s.tokens, new PasswordHasher({ ...CHEAP, N: 2 ** 11 }));
    await stronger.login('alice', PASSWORD, '203.0.113.1');
    expect(s.store.user(id)?.passwordHash).toContain('ln=11,');
    await expect(stronger.login('alice', PASSWORD, '203.0.113.1')).resolves.toBeDefined();
  });
});

describe('sessions', () => {
  it('end after 8 hours without activity', async () => {
    const s = setup();
    const { token } = await register(s);
    s.clock.advance(8 * HOUR - 1000);
    expect(s.auth.authenticate(token)).toBeDefined();
    s.clock.advance(8 * HOUR - 1000);
    expect(s.auth.authenticate(token)).toBeDefined();
    s.clock.advance(8 * HOUR);
    expect(s.auth.authenticate(token)).toBeUndefined();
    expect(s.store.sessions()).toHaveLength(0);
  });

  it('end after 7 days however active they are', async () => {
    const s = setup();
    const { token } = await register(s);
    // Used every six hours, so never idle: 27 checks up to 162 hours.
    for (let step = 1; step < 28; step++) {
      s.clock.advance(6 * HOUR);
      expect(s.auth.authenticate(token), `after ${step * 6} hours`).toBeDefined();
    }
    s.clock.advance(6 * HOUR);
    expect(s.auth.authenticate(token)).toBeUndefined();
  });

  it('write "last used" only once a minute, because every write rewrites the state file', async () => {
    const s = setup();
    const { token, id } = await register(s);
    const created = s.store.sessions()[0]!.lastUsedAt;
    s.clock.advance(30_000);
    s.auth.authenticate(token);
    expect(s.store.sessions()[0]!.lastUsedAt).toBe(created);
    s.clock.advance(31_000);
    s.auth.authenticate(token);
    expect(s.store.sessions()[0]!.lastUsedAt).not.toBe(created);
    expect(id).toBeDefined();
  });

  it('are kept as hashes: neither the token nor the password is in the state file', async () => {
    const s = setup();
    const { token } = await register(s);
    const file = readFileSync(join(dir, 'state.json'), 'utf8');
    expect(file).not.toContain(token);
    expect(file).not.toContain(PASSWORD);
    expect(file).toContain('$scrypt$');
    expect(Object.keys(JSON.parse(file).sessions)).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
  });

  it('survive a restart of the server', async () => {
    const s = setup();
    const { token } = await register(s);
    const store = new Store(dir);
    const restarted = s.build(store, new TokenService(store, ADMIN_TOKEN), new PasswordHasher(CHEAP));
    expect(restarted.authenticate(token)).toMatchObject({ kind: 'user', username: 'alice' });
    await expect(restarted.login('alice', PASSWORD, '203.0.113.1')).resolves.toBeDefined();
  });

  it('are limited to ten per user: the oldest ones make room', async () => {
    const s = setup();
    const { token: first } = await register(s);
    const tokens = [first];
    for (let i = 0; i < 11; i++) {
      s.clock.advance(1000);
      tokens.push((await s.auth.login('alice', PASSWORD, '203.0.113.1')).token);
    }
    expect(s.store.sessions()).toHaveLength(10);
    expect(s.auth.authenticate(first)).toBeUndefined();
    expect(s.auth.authenticate(tokens[1]!)).toBeUndefined();
    expect(s.auth.authenticate(tokens[2]!)).toBeDefined();
    expect(s.auth.authenticate(tokens.at(-1)!)).toBeDefined();
  });

  it('are swept: expired ones are removed and announced', async () => {
    const s = setup();
    const { token } = await register(s);
    const key = s.store.sessions()[0]!.id;
    s.clock.advance(9 * HOUR);
    s.auth.sweep();
    expect(s.store.sessions()).toHaveLength(0);
    expect(s.revoked).toContain(`session:${key}`);
    expect(s.auth.authenticate(token)).toBeUndefined();
  });

  it('can be checked again by long-lived connections, which counts as activity', async () => {
    const s = setup();
    const { token } = await register(s);
    const principal = s.auth.authenticate(token)!;
    for (let i = 0; i < 20; i++) {
      s.clock.advance(HOUR);
      expect(s.auth.touch(principal), `hour ${i}`).toBe(true);
    }
    s.clock.advance(8 * HOUR);
    expect(s.auth.touch(principal)).toBe(false);
  });
});

describe('signing out', () => {
  it('ends only this session, or all of them, and tells the listeners', async () => {
    const s = setup();
    const { token } = await register(s);
    const other = (await s.auth.login('alice', PASSWORD, '203.0.113.1')).token;
    const mine = s.auth.authenticate(token)!;
    s.auth.logout(mine, false);
    expect(s.auth.authenticate(token)).toBeUndefined();
    expect(s.auth.authenticate(other)).toBeDefined();
    expect(s.revoked).toEqual([mine.credentialId]);
    s.auth.logout(s.auth.authenticate(other)!, true);
    expect(s.store.sessions()).toHaveLength(0);
  });

  it('does nothing for API tokens, which are revoked in the token list instead', () => {
    const { auth, store } = setup();
    auth.logout(admin, true);
    expect(store.sessions()).toHaveLength(0);
  });
});

describe('administration', () => {
  it('ends the sessions of a user whose role changes, and the new role applies at once', async () => {
    const s = setup();
    const { id, token } = await register(s);
    const before = s.auth.authenticate(token)!;
    const updated = s.auth.updateUser(admin, { userId: id, role: 'admin' });
    expect(updated.role).toBe('admin');
    expect(s.auth.authenticate(token)).toBeUndefined();
    expect(s.revoked).toContain(before.credentialId);
    expect(s.auth.touch(before)).toBe(false);
    const again = await s.auth.login('alice', PASSWORD, '203.0.113.1');
    expect(again.identity.role).toBe('admin');
  });

  it('locks and unlocks accounts, ending the sessions when locking', async () => {
    const s = setup();
    const { id, token } = await register(s);
    expect(s.auth.updateUser(admin, { userId: id, disabled: true }).status).toBe('disabled');
    expect(s.auth.authenticate(token)).toBeUndefined();
    expect((await asyncCodeOf(s.auth.login('alice', PASSWORD, '203.0.113.1'))).code).toBe('unauthorized');
    expect(s.auth.updateUser(admin, { userId: id, disabled: false }).status).toBe('active');
    await expect(s.auth.login('alice', PASSWORD, '203.0.113.2')).resolves.toBeDefined();
  });

  it('changes the display name, and clears it with an empty one', async () => {
    const s = setup();
    const { id } = await register(s);
    expect(s.auth.updateUser(admin, { userId: id, displayName: 'Alice A.' }).displayName).toBe('Alice A.');
    expect(s.auth.updateUser(admin, { userId: id, displayName: '' }).displayName).toBeUndefined();
    expect(s.auth.updateUser(admin, { userId: id, displayName: null }).displayName).toBeUndefined();
  });

  it('keeps users from locking themselves out', async () => {
    const s = setup();
    const { id, token } = await register(s, 'root', 'admin');
    const self = s.auth.authenticate(token)!;
    expect(codeOf(() => s.auth.updateUser(self, { userId: id, role: 'member' }))).toBe('bad_request');
    expect(codeOf(() => s.auth.updateUser(self, { userId: id, disabled: true }))).toBe('bad_request');
    expect(codeOf(() => s.auth.deleteUser(self, id))).toBe('bad_request');
    expect(codeOf(() => s.auth.resetPassword(self, id))).toBe('bad_request');
    // Harmless changes to oneself are fine.
    expect(s.auth.updateUser(self, { userId: id, displayName: 'Root' }).displayName).toBe('Root');
    expect(s.auth.updateUser(self, { userId: id, role: 'admin', disabled: false }).role).toBe('admin');
    // Another admin, or the admin token, can do it.
    expect(s.auth.updateUser(admin, { userId: id, role: 'member' }).role).toBe('member');
  });

  it('resets a password: the old one stops working at once, and a new link is issued', async () => {
    const s = setup();
    const { id, token } = await register(s);
    const reset = s.auth.resetPassword(admin, id);
    expect(reset.user.status).toBe('invited');
    expect(s.auth.authenticate(token)).toBeUndefined();
    expect((await asyncCodeOf(s.auth.login('alice', PASSWORD, '203.0.113.1'))).code).toBe('unauthorized');
    const session = await s.auth.completeSetup(reset.setup.token, OTHER_PASSWORD, '203.0.113.1');
    expect(session.identity.user?.username).toBe('alice');
    await expect(s.auth.login('alice', OTHER_PASSWORD, '203.0.113.1')).resolves.toBeDefined();
    expect((await asyncCodeOf(s.auth.login('alice', PASSWORD, '203.0.113.9'))).code).toBe('unauthorized');
  });

  it('replaces an earlier setup link with a new one', () => {
    const { auth } = setup();
    const { user, setup: first } = auth.createUser({ username: 'alice', role: 'member' });
    const second = auth.resetPassword(admin, user.id).setup;
    expect(codeOf(() => auth.setupInfo(first.token, '203.0.113.1'))).toBe('unauthorized');
    expect(auth.setupInfo(second.token, '203.0.113.1').username).toBe('alice');
  });

  it('deletes a user together with the sessions', async () => {
    const s = setup();
    const { id, token } = await register(s);
    s.auth.deleteUser(admin, id);
    expect(s.auth.listUsers()).toEqual([]);
    expect(s.auth.authenticate(token)).toBeUndefined();
    expect(s.store.sessions()).toHaveLength(0);
    expect((await asyncCodeOf(s.auth.login('alice', PASSWORD, '203.0.113.1'))).code).toBe('unauthorized');
    expect(codeOf(() => s.auth.deleteUser(admin, id))).toBe('not_found');
  });

  it('writes the changes to the activity feed', async () => {
    const s = setup();
    const { id } = await register(s);
    s.auth.updateUser(admin, { userId: id, role: 'admin' });
    s.auth.updateUser(admin, { userId: id, disabled: true });
    s.auth.updateUser(admin, { userId: id, disabled: false });
    s.auth.resetPassword(admin, id);
    s.auth.deleteUser(admin, id);
    expect(s.activity.list(10, 'en').map((e) => e.message)).toEqual([
      'User "alice" deleted',
      'Password of "alice" reset, new setup link created',
      'User "alice" enabled again',
      'User "alice" disabled',
      '"alice" is now an admin',
      'User "alice" created',
    ]);
  });
});

describe('changing the own password', () => {
  it('needs the current password, signs out the other sessions and keeps this one', async () => {
    const s = setup();
    const { token } = await register(s);
    const other = (await s.auth.login('alice', PASSWORD, '203.0.113.1')).token;
    const mine = s.auth.authenticate(token)!;
    await s.auth.changePassword(mine, PASSWORD, OTHER_PASSWORD);
    expect(s.auth.authenticate(token)).toBeDefined();
    expect(s.auth.authenticate(other)).toBeUndefined();
    expect((await asyncCodeOf(s.auth.login('alice', PASSWORD, '203.0.113.1'))).code).toBe('unauthorized');
    await expect(s.auth.login('alice', OTHER_PASSWORD, '203.0.113.1')).resolves.toBeDefined();
  });

  it('refuses a wrong current password without signing anybody out', async () => {
    const s = setup();
    const { token } = await register(s);
    const mine = s.auth.authenticate(token)!;
    const answer = await asyncCodeOf(s.auth.changePassword(mine, 'not my password at all', OTHER_PASSWORD));
    // Not "unauthorized": the web UI signs a user out on that.
    expect(answer.code).toBe('bad_request');
    expect(s.auth.authenticate(token)).toBeDefined();
  });

  it('locks like a sign-in does, so a stolen session cannot guess the password', async () => {
    const s = setup();
    const { token } = await register(s);
    const mine = s.auth.authenticate(token)!;
    for (let i = 0; i < 5; i++) expect((await asyncCodeOf(s.auth.changePassword(mine, `wrong guess number ${i}`, OTHER_PASSWORD))).code).toBe('bad_request');
    expect((await asyncCodeOf(s.auth.changePassword(mine, PASSWORD, OTHER_PASSWORD))).code).toBe('rate_limited');
    // Counted apart from the sign-in: the account holder can still sign in.
    expect((await asyncCodeOf(s.auth.login('alice', PASSWORD, '203.0.113.1'))).code).toBeUndefined();
  });

  it('is not blocked by wrong sign-in attempts of others, who only need the name', async () => {
    const s = setup();
    const { token } = await register(s);
    const mine = s.auth.authenticate(token)!;
    for (let i = 0; i < 6; i++) await asyncCodeOf(s.auth.login('alice', `wrong guess number ${i}`, `203.0.113.${i}`));
    expect((await asyncCodeOf(s.auth.login('alice', PASSWORD, '203.0.113.50'))).code).toBe('rate_limited');
    expect((await asyncCodeOf(s.auth.changePassword(mine, PASSWORD, OTHER_PASSWORD))).code).toBeUndefined();
  });

  it('applies the password rules to the new password', async () => {
    const s = setup();
    const { token } = await register(s);
    const mine = s.auth.authenticate(token)!;
    expect((await asyncCodeOf(s.auth.changePassword(mine, PASSWORD, 'short'))).code).toBe('bad_request');
    expect((await asyncCodeOf(s.auth.changePassword(mine, PASSWORD, 'alice and her dog Rex'))).code).toBe('bad_request');
    await expect(s.auth.login('alice', PASSWORD, '203.0.113.1')).resolves.toBeDefined();
  });

  it('is not for API tokens, which have no password', async () => {
    const { auth } = setup();
    expect((await asyncCodeOf(auth.changePassword(admin, 'x', OTHER_PASSWORD))).code).toBe('bad_request');
  });
});

describe('API tokens next to users', () => {
  it('still sign in as admin, with the name of the token', () => {
    const { auth, tokens } = setup();
    expect(auth.authenticate(ADMIN_TOKEN)).toEqual({ kind: 'token', role: 'admin', credentialId: 'token:env', name: 'COCOON_TOKEN' });
    const { token, info } = tokens.create('Laptop');
    expect(auth.authenticate(token)).toEqual({ kind: 'token', role: 'admin', credentialId: `token:${info.id}`, name: 'Laptop' });
    expect(auth.identity(auth.authenticate(token)!)).toEqual({ kind: 'token', role: 'admin', tokenName: 'Laptop' });
  });

  it('announce a revoked token, so its sockets can be closed', () => {
    const { auth, tokens, revoked } = setup();
    const { token, info } = tokens.create('Laptop');
    const principal = auth.authenticate(token)!;
    expect(auth.touch(principal)).toBe(true);
    tokens.revoke(info.id);
    expect(revoked).toEqual([`token:${info.id}`]);
    expect(auth.touch(principal)).toBe(false);
    expect(auth.authenticate(token)).toBeUndefined();
    expect(auth.touch(auth.authenticate(ADMIN_TOKEN)!)).toBe(true);
  });

  it('are not mixed up with sessions', async () => {
    const s = setup();
    const { token } = await register(s);
    expect(s.tokens.identify(token)).toBeUndefined();
    expect(s.auth.authenticate(token)?.kind).toBe('user');
  });
});

describe('user ids that are not ids', () => {
  it('finds no user for names that exist on every object', () => {
    const { auth, store } = setup();
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(store.user(id), id).toBeUndefined();
      expect(codeOf(() => auth.updateUser(admin, { userId: id, role: 'admin' })), id).toBe('not_found');
      expect(codeOf(() => auth.resetPassword(admin, id)), id).toBe('not_found');
      expect(codeOf(() => auth.deleteUser(admin, id)), id).toBe('not_found');
    }
  });
});

describe('clientKey', () => {
  it('leaves IPv4 addresses as they are and unwraps IPv4-mapped ones', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    // The same address spelled in hex (::ffff:cb00:7107) and in full is the same client.
    expect(clientKey('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(clientKey('0:0:0:0:0:ffff:cb00:7107')).toBe('203.0.113.7');
    expect(clientKey('0000:0000:0000:0000:0000:FFFF:203.0.113.7')).toBe('203.0.113.7');
    expect(clientKey(undefined)).toBeUndefined();
    expect(clientKey('')).toBeUndefined();
  });

  it('maps every address of an IPv6 /64 to one key', () => {
    const key = clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(key).toBe('2001:db8:1:2::/64');
    expect(clientKey('2001:db8:1:2::1')).toBe(key);
    expect(clientKey('2001:0db8:0001:0002:0000:0000:0000:0001')).toBe(key);
    expect(clientKey('2001:db8:1:3::1')).not.toBe(key);
    expect(clientKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey('2001:db8::')).toBe('2001:db8:0:0::/64');
  });
});
