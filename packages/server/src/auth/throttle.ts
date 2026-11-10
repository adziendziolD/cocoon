export interface ThrottleOptions {
  /** Wrong attempts on one account before it is locked for the first time. */
  freeAttempts: number;
  /** First lock; every further wrong attempt doubles it. */
  baseLockMs: number;
  maxLockMs: number;
  /** Wrong attempts from one client address within `windowMs` before that address is blocked. */
  addressLimit: number;
  windowMs: number;
  /** Upper bound of remembered accounts and addresses: the names are chosen by whoever tries. */
  maxEntries: number;
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  freeAttempts: 5,
  baseLockMs: 30_000,
  maxLockMs: 15 * 60_000,
  addressLimit: 20,
  windowMs: 10 * 60_000,
  maxEntries: 10_000,
};

interface AccountState {
  failures: number;
  lockedUntil: number;
  last: number;
}

interface AddressState {
  count: number;
  windowStart: number;
}

/**
 * Slows down guessing of passwords (and of setup links), in memory.
 * An account is locked after a few wrong attempts, for longer each time. The lock applies to any name, known or not,
 * so it does not reveal which accounts exist. A client address gets a budget of wrong attempts per time window, which
 * stops one address from trying one password on many accounts.
 */
export class LoginThrottle {
  private readonly accounts = new Map<string, AccountState>();
  private readonly addresses = new Map<string, AddressState>();

  constructor(
    private readonly options: ThrottleOptions = DEFAULT_THROTTLE,
    private readonly now: () => number = Date.now,
  ) {}

  /** Milliseconds the caller has to wait before the next attempt; 0 if it may try now. */
  wait(account: string | undefined, address: string | undefined): number {
    const now = this.now();
    let wait = 0;
    const accountState = account === undefined ? undefined : this.accounts.get(account);
    if (accountState) {
      // After the longest lock plus some quiet time the account starts over.
      if (now - accountState.last > this.options.maxLockMs && accountState.lockedUntil <= now) this.accounts.delete(account!);
      else wait = Math.max(wait, accountState.lockedUntil - now);
    }
    const addressState = address === undefined ? undefined : this.addresses.get(address);
    if (addressState) {
      if (now - addressState.windowStart >= this.options.windowMs) this.addresses.delete(address!);
      else if (addressState.count >= this.options.addressLimit) wait = Math.max(wait, addressState.windowStart + this.options.windowMs - now);
    }
    return Math.max(0, wait);
  }

  failure(account: string | undefined, address: string | undefined): void {
    const now = this.now();
    if (account !== undefined) {
      const state = this.accounts.get(account) ?? { failures: 0, lockedUntil: 0, last: now };
      state.failures++;
      state.last = now;
      if (state.failures >= this.options.freeAttempts) {
        const lock = Math.min(this.options.maxLockMs, this.options.baseLockMs * 2 ** (state.failures - this.options.freeAttempts));
        state.lockedUntil = now + lock;
      }
      remember(this.accounts, account, state, this.options.maxEntries);
    }
    if (address !== undefined) {
      const current = this.addresses.get(address);
      const state = current && now - current.windowStart < this.options.windowMs ? current : { count: 0, windowStart: now };
      state.count++;
      remember(this.addresses, address, state, this.options.maxEntries);
    }
  }

  /** A correct password ends the lock of that account. The address budget stays: one valid login must not reset a guesser. */
  success(account: string): void {
    this.accounts.delete(account);
  }

  /** Takes back the one attempt an address was charged in advance (see `failure`), because it turned out to be right. */
  refund(address: string | undefined): void {
    const state = address === undefined ? undefined : this.addresses.get(address);
    if (state && state.count > 0) state.count--;
  }
}

/** Stores the entry as the most recent one and drops the oldest when the map is full. */
function remember<T>(map: Map<string, T>, key: string, state: T, max: number): void {
  map.delete(key);
  map.set(key, state);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
