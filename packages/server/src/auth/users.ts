import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIPv6 } from 'node:net';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  type Identity,
  type SessionResult,
  type SetupInfoResult,
  type SetupLink,
  type UserInfo,
  type UserRole,
} from '@cocoon/protocol';
import type { ActivityLog } from '../activity.ts';
import { CocoonError, notFound } from '../errors.ts';
import { t, type MessageKey } from '../i18n.ts';
import { newId } from '../ids.ts';
import type { SessionRecord, Store, UserRecord } from '../store.ts';
import type { TokenService } from '../tokens.ts';
import { PasswordHasher, passwordProblem, type PasswordProblem } from './password.ts';
import { SESSION_PREFIX, TOKEN_PREFIX, type Principal } from './principal.ts';
import { LoginThrottle } from './throttle.ts';

export interface AuthOptions {
  /** A session ends after this long without activity ... */
  sessionIdleMs: number;
  /** ... and after this long in any case. */
  sessionMaxMs: number;
}

export interface AuthDeps {
  hasher?: PasswordHasher;
  throttle?: LoginThrottle;
  log?: (message: string, err?: unknown) => void;
  now?: () => number;
}

const SESSION_TOKEN_PREFIX = 'ccs_';
const SETUP_TOKEN_PREFIX = 'ccu_';
/** How long a setup link works. */
const SETUP_LINK_MS = 72 * 3_600_000;
/** "Last used" is written at most this often: every write rewrites state.json. */
const TOUCH_INTERVAL_MS = 60_000;
const SWEEP_INTERVAL_MS = 60_000;
/** A user who signs in on more browsers than this ends their oldest session. */
const MAX_SESSIONS_PER_USER = 10;

const PASSWORD_MESSAGES: Record<PasswordProblem, MessageKey> = {
  tooShort: 'error.passwordTooShort',
  tooLong: 'error.passwordTooLong',
  common: 'error.passwordCommon',
  username: 'error.passwordUsername',
};

const sha256 = (value: string) => createHash('sha256').update(value).digest();

function sameHash(storedHex: string, hash: Buffer): boolean {
  const stored = Buffer.from(storedHex, 'hex');
  return stored.length === hash.length && timingSafeEqual(stored, hash);
}

/**
 * The key the throttle counts a client under. An IPv6 customer owns a whole /64 and can switch addresses at will, so the
 * network counts as one client; IPv4-mapped addresses are plain IPv4.
 */
export function clientKey(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const ip = address.split('%')[0] ?? address;
  if (!isIPv6(ip)) return ip;
  const groups = expandIPv6(ip);
  // ::ffff:a.b.c.d in any spelling (dotted or hex) is plain IPv4.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

/** The eight 16-bit groups of an IPv6 address (a dotted IPv4 tail counts as two). */
function expandIPv6(ip: string): number[] {
  const toGroups = (part: string): number[] =>
    part
      ? part.split(':').flatMap((piece) => {
          if (!piece.includes('.')) return [parseInt(piece, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = piece.split('.').map(Number);
          return [(a << 8) | b, (c << 8) | d];
        })
      : [];
  const [headPart = '', tailPart] = ip.split('::');
  const head = toGroups(headPart);
  const tail = tailPart === undefined ? [] : toGroups(tailPart);
  return tailPart === undefined ? head : [...head, ...Array<number>(Math.max(0, 8 - head.length - tail.length)).fill(0), ...tail];
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Sign-in of users with a password, their sessions and the account administration.
 * API and admin tokens stay what they were (TokenService); `authenticate` accepts both and says who is calling.
 */
export class AuthService {
  private readonly hasher: PasswordHasher;
  private readonly throttle: LoginThrottle;
  private readonly log: (message: string, err?: unknown) => void;
  private readonly now: () => number;
  private readonly listeners = new Set<(credentialId: string) => void>();
  private decoy?: Promise<string>;
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly store: Store,
    private readonly tokens: TokenService,
    private readonly activity: ActivityLog,
    private readonly options: AuthOptions,
    deps: AuthDeps = {},
  ) {
    this.hasher = deps.hasher ?? new PasswordHasher();
    this.throttle = deps.throttle ?? new LoginThrottle();
    this.log = deps.log ?? (() => undefined);
    this.now = deps.now ?? Date.now;
    tokens.onRevoked((id) => this.notify(`${TOKEN_PREFIX}${id}`));
  }

  /** Ends expired sessions regularly; open sockets of those sessions are closed through onRevoked. */
  start(): void {
    void this.decoyHash().catch(() => undefined);
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  stop(): void {
    clearInterval(this.sweeper);
  }

  /** Called with the credential of a token or session that stopped working, e.g. to close its sockets. */
  onRevoked(listener: (credentialId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Who is calling ─────────────────────────────────────────────────────────

  authenticate(provided: string | undefined): Principal | undefined {
    if (!provided) return undefined;
    const token = this.tokens.identify(provided);
    if (token) return { kind: 'token', role: 'admin', credentialId: `${TOKEN_PREFIX}${token.id}`, name: token.name };
    return this.authenticateSession(provided);
  }

  private authenticateSession(token: string): Principal | undefined {
    const id = sha256(token).toString('hex');
    const session = this.store.session(id);
    if (!session) return undefined;
    const user = this.store.user(session.userId);
    if (!user || user.disabled || this.expired(session)) {
      this.endSessions([id]);
      return undefined;
    }
    this.touchSession(session);
    return { kind: 'user', role: user.role, credentialId: `${SESSION_PREFIX}${id}`, userId: user.id, username: user.username, displayName: user.displayName };
  }

  /**
   * For connections that outlive the request (sockets): is the caller still allowed? Counts as activity, so a person typing
   * into a terminal is not signed out for being idle.
   */
  touch(principal: Principal): boolean {
    if (principal.kind === 'token') return this.tokens.isActive(principal.credentialId.slice(TOKEN_PREFIX.length));
    const session = this.store.session(principal.credentialId.slice(SESSION_PREFIX.length));
    const user = session && this.store.user(session.userId);
    if (!session || !user || user.disabled || user.role !== principal.role || this.expired(session)) return false;
    this.touchSession(session);
    return true;
  }

  identity(caller: Principal): Identity {
    if (caller.kind === 'token') return { kind: 'token', role: 'admin', tokenName: caller.name };
    const session = this.store.session(caller.credentialId.slice(SESSION_PREFIX.length));
    return {
      kind: 'user',
      role: caller.role,
      user: { id: caller.userId, username: caller.username, ...(caller.displayName ? { displayName: caller.displayName } : {}) },
      ...(session ? { sessionExpiresAt: session.expiresAt } : {}),
    };
  }

  private expired(session: SessionRecord): boolean {
    const now = this.now();
    return now >= Date.parse(session.expiresAt) || now - Date.parse(session.lastUsedAt) >= this.options.sessionIdleMs;
  }

  private touchSession(session: SessionRecord): void {
    const now = this.now();
    if (now - Date.parse(session.lastUsedAt) >= TOUCH_INTERVAL_MS) this.store.putSession({ ...session, lastUsedAt: iso(now) });
  }

  // ── Signing in ─────────────────────────────────────────────────────────────

  async login(username: string, password: string, address: string | undefined): Promise<SessionResult> {
    const account = username.trim().toLowerCase();
    const client = clientKey(address);
    this.assertAllowed(account, client);
    // Charged before the hash is computed (which takes a while): attempts that arrive at the same time would otherwise all
    // pass the check above. A correct password takes it back below.
    this.throttle.failure(account, client);
    const user = this.store.users().find((candidate) => candidate.username === account);
    const hash = user?.passwordHash;
    // An unknown name, a pending invitation and a wrong password all cost one hash and end in the same answer.
    const valid = hash ? await this.hasher.verify(password, hash) : (await this.hasher.verify(password, await this.decoyHash()), false);
    // Hashes made with older, cheaper parameters are renewed now that the password is at hand.
    const renewed = valid && hash && this.hasher.needsRehash(hash) ? await this.hasher.hash(password) : undefined;
    // Read the account again: it may have been locked, reset or deleted while the hashes were computed.
    const current = user && this.store.user(user.id);
    if (!valid || !user || !hash || !current || current.disabled || current.passwordHash !== hash) {
      this.log(`sign-in failed (${user ? `user ${user.id}` : 'unknown name'})`);
      throw new CocoonError('unauthorized', t('error.loginFailed'));
    }
    this.throttle.success(account);
    this.throttle.refund(client);
    const updated: UserRecord = { ...current, lastLoginAt: iso(this.now()), ...(renewed ? { passwordHash: renewed } : {}) };
    this.store.putUser(updated);
    return this.startSession(updated);
  }

  /** Hash of a random password: unknown names are checked against it so they take as long as real ones. */
  private decoyHash(): Promise<string> {
    // A failed attempt (e.g. the hash queue was full) must not stay: unknown names would answer differently from then on.
    this.decoy ??= this.hasher.hash(randomBytes(24).toString('base64')).catch((err: unknown) => {
      this.decoy = undefined;
      throw err;
    });
    return this.decoy;
  }

  private assertAllowed(account: string | undefined, client: string | undefined): void {
    const waitMs = this.throttle.wait(account, client);
    if (waitMs <= 0) return;
    const seconds = Math.ceil(waitMs / 1000);
    throw new CocoonError('rate_limited', t('error.rateLimited', { seconds }), { retryAfterSeconds: seconds });
  }

  private startSession(user: UserRecord): SessionResult {
    const token = `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const now = this.now();
    const session: SessionRecord = { id: sha256(token).toString('hex'), userId: user.id, createdAt: iso(now), lastUsedAt: iso(now), expiresAt: iso(now + this.options.sessionMaxMs) };
    // The oldest sessions make room, so the number per user (and the state file) stays small.
    const own = this.store.sessions().filter((s) => s.userId === user.id).sort((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt));
    this.endSessions(own.slice(0, Math.max(0, own.length - (MAX_SESSIONS_PER_USER - 1))).map((s) => s.id));
    this.store.putSession(session);
    const caller: Principal = { kind: 'user', role: user.role, credentialId: `${SESSION_PREFIX}${session.id}`, userId: user.id, username: user.username, displayName: user.displayName };
    return { token, expiresAt: session.expiresAt, identity: this.identity(caller) };
  }

  logout(caller: Principal, everywhere: boolean): void {
    if (caller.kind !== 'user') return;
    const own = caller.credentialId.slice(SESSION_PREFIX.length);
    this.endSessions(this.store.sessions().filter((s) => s.userId === caller.userId && (everywhere || s.id === own)).map((s) => s.id));
  }

  // ── Choosing a password: new users and resets ──────────────────────────────

  setupInfo(token: string, address: string | undefined): SetupInfoResult {
    const user = this.userForSetup(token, clientKey(address));
    return { username: user.username, ...(user.displayName ? { displayName: user.displayName } : {}) };
  }

  async completeSetup(token: string, password: string, address: string | undefined): Promise<SessionResult> {
    const user = this.userForSetup(token, clientKey(address));
    this.assertPassword(password, user.username);
    const passwordHash = await this.hasher.hash(password);
    // The link may have been used or replaced while the password was being hashed.
    const current = this.store.user(user.id);
    if (!current?.setup || current.setup.hash !== user.setup.hash || current.disabled) throw new CocoonError('unauthorized', t('error.setupInvalid'));
    const { setup: _used, ...rest } = current;
    const now = iso(this.now());
    const updated: UserRecord = { ...rest, passwordHash, passwordSetAt: now, lastLoginAt: now };
    this.store.putUser(updated);
    this.endSessions(this.sessionIdsOf(updated.id));
    return this.startSession(updated);
  }

  private userForSetup(token: string, client: string | undefined): UserRecord & { setup: NonNullable<UserRecord['setup']> } {
    this.assertAllowed(undefined, client);
    const hash = sha256(token);
    const user = this.store.users().find((candidate) => candidate.setup && sameHash(candidate.setup.hash, hash));
    if (!user?.setup || user.disabled || Date.parse(user.setup.expiresAt) <= this.now()) {
      this.throttle.failure(undefined, client);
      throw new CocoonError('unauthorized', t('error.setupInvalid'));
    }
    return { ...user, setup: user.setup };
  }

  private assertPassword(password: string, username: string): void {
    const problem = passwordProblem(password, username);
    if (problem) throw new CocoonError('bad_request', t(PASSWORD_MESSAGES[problem], { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH }));
  }

  private newSetup(): { link: SetupLink; stored: NonNullable<UserRecord['setup']> } {
    const token = `${SETUP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const expiresAt = iso(this.now() + SETUP_LINK_MS);
    return { link: { token, expiresAt }, stored: { hash: sha256(token).toString('hex'), expiresAt } };
  }

  // ── Own password ───────────────────────────────────────────────────────────

  async changePassword(caller: Principal, currentPassword: string, newPassword: string): Promise<void> {
    if (caller.kind !== 'user') throw new CocoonError('bad_request', t('error.noPassword'));
    const user = this.userById(caller.userId);
    // A stolen session must not be able to guess the password: the same kind of lock as at sign-in applies, but counted apart,
    // so wrong sign-in attempts by others (who only need the name) do not block the account holder here.
    const key = `password:${user.id}`;
    this.assertAllowed(key, undefined);
    this.throttle.failure(key, undefined);
    const hash = user.passwordHash;
    if (!hash || !(await this.hasher.verify(currentPassword, hash))) throw new CocoonError('bad_request', t('error.passwordWrong'));
    this.throttle.success(key);
    this.assertPassword(newPassword, user.username);
    const passwordHash = await this.hasher.hash(newPassword);
    const current = this.userById(user.id);
    if (current.passwordHash !== hash) throw new CocoonError('conflict', t('error.busy'));
    this.store.putUser({ ...current, passwordHash, passwordSetAt: iso(this.now()) });
    // Whoever knew the old password (or held a stolen session) is signed out; this browser stays.
    const keep = caller.credentialId.slice(SESSION_PREFIX.length);
    this.endSessions(this.sessionIdsOf(user.id).filter((id) => id !== keep));
  }

  // ── Administration ─────────────────────────────────────────────────────────

  listUsers(): UserInfo[] {
    return this.store.users().sort((a, b) => a.username.localeCompare(b.username)).map((user) => this.info(user));
  }

  createUser(input: { username: string; displayName?: string; role: UserRole }): { user: UserInfo; setup: SetupLink } {
    const username = input.username.trim().toLowerCase();
    if (this.store.users().some((user) => user.username === username)) throw new CocoonError('conflict', t('error.usernameTaken', { name: username }));
    const { link, stored } = this.newSetup();
    const user: UserRecord = {
      id: newId('us'),
      username,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      role: input.role,
      setup: stored,
      createdAt: iso(this.now()),
    };
    this.store.putUser(user);
    this.activity.add('info', 'activity.userCreated', { name: username });
    return { user: this.info(user), setup: link };
  }

  updateUser(caller: Principal, input: { userId: string; role?: UserRole; displayName?: string | null; disabled?: boolean }): UserInfo {
    const user = this.userById(input.userId);
    const roleChanged = input.role !== undefined && input.role !== user.role;
    const disabledChanged = input.disabled !== undefined && input.disabled !== Boolean(user.disabled);
    if (this.isSelf(caller, user) && (roleChanged || input.disabled === true)) throw new CocoonError('bad_request', t('error.userSelf'));
    const { displayName: _name, ...rest } = user;
    const displayName = input.displayName === undefined ? user.displayName : input.displayName || undefined;
    const next: UserRecord = { ...rest, ...(displayName ? { displayName } : {}) };
    if (roleChanged) next.role = input.role!;
    if (disabledChanged) {
      if (input.disabled) next.disabled = true;
      else delete next.disabled;
    }
    this.store.putUser(next);
    // Sessions carry no role: ending them makes a new role or a lock effective at once, also on open sockets.
    if (roleChanged || input.disabled) this.endSessions(this.sessionIdsOf(user.id));
    if (roleChanged) this.activity.add('info', next.role === 'admin' ? 'activity.userAdmin' : 'activity.userMember', { name: user.username });
    if (disabledChanged) this.activity.add('info', input.disabled ? 'activity.userDisabled' : 'activity.userEnabled', { name: user.username });
    return this.info(next);
  }

  /** The password stops working and every session ends; the user chooses a new password with the returned link. */
  resetPassword(caller: Principal, userId: string): { user: UserInfo; setup: SetupLink } {
    const user = this.userById(userId);
    if (this.isSelf(caller, user)) throw new CocoonError('bad_request', t('error.userSelf'));
    const { passwordHash: _old, passwordSetAt: _at, ...rest } = user;
    const { link, stored } = this.newSetup();
    const next: UserRecord = { ...rest, setup: stored };
    this.store.putUser(next);
    this.endSessions(this.sessionIdsOf(user.id));
    this.activity.add('info', 'activity.userReset', { name: user.username });
    return { user: this.info(next), setup: link };
  }

  deleteUser(caller: Principal, userId: string): void {
    const user = this.userById(userId);
    if (this.isSelf(caller, user)) throw new CocoonError('bad_request', t('error.userSelf'));
    this.endSessions(this.sessionIdsOf(user.id));
    this.store.deleteUser(user.id);
    this.activity.add('info', 'activity.userDeleted', { name: user.username });
  }

  private userById(userId: string): UserRecord {
    const user = this.store.user(userId);
    if (!user) throw notFound('user', userId);
    return user;
  }

  private isSelf(caller: Principal, user: UserRecord): boolean {
    return caller.kind === 'user' && caller.userId === user.id;
  }

  private info(user: UserRecord): UserInfo {
    return {
      id: user.id,
      username: user.username,
      ...(user.displayName ? { displayName: user.displayName } : {}),
      role: user.role,
      status: user.disabled ? 'disabled' : user.passwordHash ? 'active' : 'invited',
      createdAt: user.createdAt,
      ...(user.lastLoginAt ? { lastLoginAt: user.lastLoginAt } : {}),
      ...(user.passwordSetAt ? { passwordSetAt: user.passwordSetAt } : {}),
      ...(user.setup ? { setupExpiresAt: user.setup.expiresAt } : {}),
      sessions: this.sessionIdsOf(user.id).length,
    };
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  private sessionIdsOf(userId: string): string[] {
    return this.store.sessions().filter((session) => session.userId === userId).map((session) => session.id);
  }

  /** Removes sessions (one write) and tells the listeners, which close the sockets that belong to them. */
  private endSessions(ids: string[]): void {
    if (!ids.length) return;
    this.store.deleteSessions(ids);
    for (const id of ids) this.notify(`${SESSION_PREFIX}${id}`);
  }

  /** Sessions of removed or locked users and expired ones. */
  sweep(): void {
    const dead = this.store
      .sessions()
      .filter((session) => {
        const user = this.store.user(session.userId);
        return !user || user.disabled || this.expired(session);
      })
      .map((session) => session.id);
    this.endSessions(dead);
  }

  private notify(credentialId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(credentialId);
      } catch (err) {
        this.log('revocation listener failed', err);
      }
    }
  }
}
