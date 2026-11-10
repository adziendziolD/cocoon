import { describe, expect, it } from 'vitest';
import { DEFAULT_THROTTLE, LoginThrottle } from './throttle.ts';

function setup(options = {}) {
  let time = 1_000_000;
  const throttle = new LoginThrottle({ ...DEFAULT_THROTTLE, ...options }, () => time);
  return { throttle, advance: (ms: number) => void (time += ms) };
}

const fail = (throttle: LoginThrottle, account: string | undefined, address: string | undefined, times: number) => {
  for (let i = 0; i < times; i++) throttle.failure(account, address);
};

describe('LoginThrottle accounts', () => {
  it('allows a few wrong attempts, then locks the account', () => {
    const { throttle } = setup();
    fail(throttle, 'alice', undefined, 4);
    expect(throttle.wait('alice', undefined)).toBe(0);
    throttle.failure('alice', undefined);
    expect(throttle.wait('alice', undefined)).toBe(30_000);
  });

  it('locks for twice as long with every further wrong attempt, up to a maximum', () => {
    const { throttle, advance } = setup();
    fail(throttle, 'alice', undefined, 5);
    expect(throttle.wait('alice', undefined)).toBe(30_000);
    advance(30_000);
    expect(throttle.wait('alice', undefined)).toBe(0);
    throttle.failure('alice', undefined);
    expect(throttle.wait('alice', undefined)).toBe(60_000);
    advance(60_000);
    throttle.failure('alice', undefined);
    expect(throttle.wait('alice', undefined)).toBe(120_000);
    for (let i = 0; i < 20; i++) {
      advance(15 * 60_000);
      throttle.failure('alice', undefined);
    }
    expect(throttle.wait('alice', undefined)).toBe(15 * 60_000);
  });

  it('counts down while the lock runs', () => {
    const { throttle, advance } = setup();
    fail(throttle, 'alice', undefined, 5);
    advance(10_000);
    expect(throttle.wait('alice', undefined)).toBe(20_000);
  });

  it('forgets the wrong attempts after a correct password', () => {
    const { throttle } = setup();
    fail(throttle, 'alice', undefined, 4);
    throttle.success('alice');
    fail(throttle, 'alice', undefined, 4);
    expect(throttle.wait('alice', undefined)).toBe(0);
  });

  it('starts over after a long quiet time', () => {
    const { throttle, advance } = setup();
    fail(throttle, 'alice', undefined, 4);
    advance(16 * 60_000);
    expect(throttle.wait('alice', undefined)).toBe(0);
    fail(throttle, 'alice', undefined, 4);
    expect(throttle.wait('alice', undefined)).toBe(0);
  });

  it('locks names that do not exist in exactly the same way', () => {
    const { throttle } = setup();
    fail(throttle, 'nobody', undefined, 5);
    expect(throttle.wait('nobody', undefined)).toBe(30_000);
  });

  it('keeps accounts apart', () => {
    const { throttle } = setup();
    fail(throttle, 'alice', undefined, 5);
    expect(throttle.wait('bob', undefined)).toBe(0);
  });
});

describe('LoginThrottle addresses', () => {
  it('blocks an address that tries too often, whichever account it tries', () => {
    const { throttle } = setup();
    for (let i = 0; i < 20; i++) throttle.failure(`user${i}`, '203.0.113.7');
    expect(throttle.wait('someone-new', '203.0.113.7')).toBe(10 * 60_000);
    expect(throttle.wait('someone-new', '203.0.113.8')).toBe(0);
  });

  it('lets the address try again when the window is over', () => {
    const { throttle, advance } = setup();
    fail(throttle, undefined, '203.0.113.7', 20);
    advance(10 * 60_000 - 1);
    expect(throttle.wait(undefined, '203.0.113.7')).toBeGreaterThan(0);
    advance(1);
    expect(throttle.wait(undefined, '203.0.113.7')).toBe(0);
  });

  it('does not let a correct login clear the budget of the address', () => {
    const { throttle } = setup();
    for (let i = 0; i < 20; i++) throttle.failure('alice', '203.0.113.7');
    throttle.success('alice');
    expect(throttle.wait('bob', '203.0.113.7')).toBeGreaterThan(0);
  });

  it('takes the longer of both waits', () => {
    const { throttle } = setup();
    fail(throttle, 'alice', '203.0.113.7', 5);
    expect(throttle.wait('alice', '203.0.113.7')).toBe(30_000);
  });
});

describe('LoginThrottle memory', () => {
  it('remembers a bounded number of names, so guessing names cannot fill the memory', () => {
    const { throttle } = setup({ maxEntries: 50 });
    for (let i = 0; i < 1000; i++) fail(throttle, `guess${i}`, `10.0.${i >> 8}.${i & 255}`, 5);
    // The latest are still locked, the earliest were forgotten.
    expect(throttle.wait('guess999', undefined)).toBeGreaterThan(0);
    expect(throttle.wait('guess0', undefined)).toBe(0);
  });
});
