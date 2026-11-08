import { describe, expect, it } from 'vitest';
import { DEFAULT_COST, hashPassword, needsRehash, PasswordHasher, passwordProblem, verifyPassword } from './password.ts';

/** Cheap parameters keep the tests fast; the format and the checks are the same as with the real cost. */
const CHEAP = { N: 2 ** 10, r: 8, p: 1 };

describe('password hashing', () => {
  it('stores a salted scrypt hash with its parameters and verifies the right password only', async () => {
    const hash = await hashPassword('correct horse battery staple', CHEAP);
    expect(hash).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(hash).not.toContain('correct horse');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('uses a new salt every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same password, twice', CHEAP), hashPassword('same password, twice', CHEAP)]);
    expect(a).not.toBe(b);
  });

  it('treats equivalent Unicode spellings as the same password', async () => {
    const hash = await hashPassword('Café au lait am Morgen', CHEAP);
    expect(await verifyPassword('Café au lait am Morgen', hash)).toBe(true);
  });

  it('does not verify anything that is not a hash of ours', async () => {
    for (const bad of ['', 'plaintext', '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaA', '$scrypt$ln=10,r=8,p=1$short$short']) {
      expect(await verifyPassword('anything', bad), bad).toBe(false);
    }
  });

  it('refuses hashes that ask for absurd amounts of memory instead of computing them', async () => {
    const hash = await hashPassword('a perfectly fine password', CHEAP);
    const greedy = hash.replace('ln=10,r=8,p=1', 'ln=30,r=8,p=1');
    const started = Date.now();
    expect(await verifyPassword('a perfectly fine password', greedy)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(needsRehash(greedy)).toBe(true);
  });

  it('asks for a new hash when the parameters are weaker than today, and only then', async () => {
    const weak = await hashPassword('rehash me when I sign in', CHEAP);
    expect(needsRehash(weak, DEFAULT_COST)).toBe(true);
    expect(needsRehash(weak, CHEAP)).toBe(false);
    expect(needsRehash(weak, { ...CHEAP, N: 2 ** 9 })).toBe(false);
    expect(needsRehash('garbage', CHEAP)).toBe(true);
  });

  it('defaults to the OWASP minimum for scrypt', () => {
    expect(DEFAULT_COST).toEqual({ N: 131072, r: 8, p: 1 });
  });
});

describe('PasswordHasher', () => {
  it('hashes and verifies', async () => {
    const hasher = new PasswordHasher(CHEAP);
    const hash = await hasher.hash('a long enough passphrase');
    expect(await hasher.verify('a long enough passphrase', hash)).toBe(true);
    expect(await hasher.verify('another long passphrase', hash)).toBe(false);
    expect(hasher.needsRehash(hash)).toBe(false);
  });

  it('works through a burst and refuses what would pile up beyond the queue', async () => {
    const hasher = new PasswordHasher(CHEAP);
    // Two run, sixteen wait, the rest is turned away at once instead of queueing up memory use.
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => hasher.hash(`burst password ${i} of many`)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(18);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(2);
    expect(rejected.every((r) => (r.reason as { code?: string }).code === 'rate_limited')).toBe(true);
    // The queue is empty again afterwards.
    await expect(hasher.hash('and one more afterwards')).resolves.toMatch(/^\$scrypt\$/);
  });
});

describe('passwordProblem', () => {
  it('requires 12 characters and counts characters, not bytes', () => {
    expect(passwordProblem('short')).toBe('tooShort');
    expect(passwordProblem('elf chars!!')).toBe('tooShort');
    expect(passwordProblem('twelve chars')).toBeUndefined();
    // 12 emoji are 12 characters (but 48 bytes).
    expect(passwordProblem('🔐🌲🌊🔥🌙🍀🎲🚀🧩🎸🍋🪁')).toBeUndefined();
    expect(passwordProblem('🔐🌲🌊🔥🌙🍀🎲🚀🧩🎸🍋')).toBe('tooShort');
  });

  it('allows long passphrases up to 256 characters', () => {
    // Not a repetition or a sequence, so only the length is looked at.
    const long = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + ((i * 7 + (i >> 3)) % 26))).join('');
    expect(passwordProblem(long(100))).toBeUndefined();
    expect(passwordProblem(long(256))).toBeUndefined();
    expect(passwordProblem(long(257))).toBe('tooLong');
  });

  it('rejects well-known passwords, repetitions and sequences', () => {
    expect(passwordProblem('Password1234')).toBe('common');
    expect(passwordProblem('correcthorsebatterystaple')).toBe('common');
    expect(passwordProblem('aaaaaaaaaaaa')).toBe('common');
    expect(passwordProblem('abababababab')).toBe('common');
    expect(passwordProblem('abcdabcdabcdabcd')).toBe('common');
    expect(passwordProblem('123456789012')).toBe('common');
    expect(passwordProblem('abcdefghijkl')).toBe('common');
    expect(passwordProblem('210987654321')).toBe('common');
  });

  it('rejects a password that contains the username, but not short names', () => {
    expect(passwordProblem('my-alice.smith-password', 'alice.smith')).toBe('username');
    expect(passwordProblem('ALICE.SMITH is great!', 'alice.smith')).toBe('username');
    expect(passwordProblem('my-bob-password-here', 'bob')).toBeUndefined();
    expect(passwordProblem('unrelated horse staple', 'alice.smith')).toBeUndefined();
  });

  it('accepts ordinary passphrases without rules about character classes', () => {
    expect(passwordProblem('three small clouds over the harbour')).toBeUndefined();
    expect(passwordProblem('lowercase only but long enough')).toBeUndefined();
  });
});
