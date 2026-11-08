import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@cocoon/protocol';
import { CocoonError } from '../errors.ts';
import { t } from '../i18n.ts';

export interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

/** The minimum OWASP recommends for scrypt: N = 2^17 (128 MiB of memory), r = 8, p = 1. */
export const DEFAULT_COST: ScryptCost = { N: 2 ** 17, r: 8, p: 1 };
/** A stored hash that asks for more memory than this is not computed: a manipulated state file must not exhaust the server. */
const MAX_MEMORY = 512 * 1024 * 1024;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

const memoryOf = ({ N, r }: ScryptCost) => 128 * N * r;

function derive(password: string, salt: Buffer, cost: ScryptCost, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFKC: the same password typed on another keyboard or system has the same bytes.
    const options = { N: cost.N, r: cost.r, p: cost.p, maxmem: Math.ceil(memoryOf(cost) * 1.25) + (1 << 20) };
    scrypt(password.normalize('NFKC'), salt, length, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

const base64 = (value: Buffer) => value.toString('base64').replace(/=+$/, '');

/** `$scrypt$ln=17,r=8,p=1$<salt>$<hash>`: the cost is part of the hash, so it can be raised later. */
export async function hashPassword(password: string, cost: ScryptCost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, cost, KEY_LENGTH);
  return `$scrypt$ln=${Math.log2(cost.N)},r=${cost.r},p=${cost.p}$${base64(salt)}$${base64(key)}`;
}

const FORMAT = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,64})\$([A-Za-z0-9+/]{16,128})$/;

function parse(encoded: string): { cost: ScryptCost; salt: Buffer; key: Buffer } | undefined {
  const match = FORMAT.exec(encoded);
  if (!match) return undefined;
  const cost = { N: 2 ** Number(match[1]), r: Number(match[2]), p: Number(match[3]) };
  if (cost.N < 2 || cost.r < 1 || cost.p < 1 || memoryOf(cost) > MAX_MEMORY) return undefined;
  return { cost, salt: Buffer.from(match[4]!, 'base64'), key: Buffer.from(match[5]!, 'base64') };
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parse(encoded);
  if (!parsed) return false;
  const key = await derive(password, parsed.salt, parsed.cost, parsed.key.length);
  return timingSafeEqual(key, parsed.key);
}

/** True if the hash was made with a lower cost than wanted today: it is renewed at the next sign-in. */
export function needsRehash(encoded: string, cost: ScryptCost = DEFAULT_COST): boolean {
  const parsed = parse(encoded);
  return !parsed || parsed.cost.N < cost.N || parsed.cost.r < cost.r || parsed.cost.p < cost.p;
}

/** Runs a few jobs at once and lets a limited number wait: every hash takes 128 MiB, and sign-ins come from anyone. */
class JobQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly maxWaiting: number,
  ) {}

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.maxWaiting) throw new CocoonError('rate_limited', t('error.busy'), { retryAfterSeconds: 5 });
      // The slot is handed over by the job that finishes, so `active` stays as it is.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active++;
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export class PasswordHasher {
  private readonly queue = new JobQueue(2, 16);

  constructor(private readonly cost: ScryptCost = DEFAULT_COST) {}

  hash(password: string): Promise<string> {
    return this.queue.run(() => hashPassword(password, this.cost));
  }

  verify(password: string, encoded: string): Promise<boolean> {
    return this.queue.run(() => verifyPassword(password, encoded));
  }

  needsRehash(encoded: string): boolean {
    return needsRehash(encoded, this.cost);
  }
}

export type PasswordProblem = 'tooShort' | 'tooLong' | 'common' | 'username';

/** Passwords people pick even at 12 characters or more. Length is the real protection; this only catches the worst. */
const COMMON = new Set([
  'password1234', 'password12345', 'password123456', 'passwordpassword', 'password1234567', 'passw0rd1234', 'p@ssw0rd1234',
  'passwort1234', 'passwort12345', 'passwort123456', 'willkommen123', 'willkommen1234', 'hallo1234567', 'hallo12345678',
  'qwertyuiop12', 'qwertyuiop123', 'qwertyuiopas', 'qwertyuiopasdf', 'qwertzuiop12', 'qwertzuiop123', 'qwertzuiopasdf',
  '1q2w3e4r5t6y', '1qaz2wsx3edc', '1q2w3e4r5t6y7u', 'asdfghjkl123', 'asdfghjklqwer', 'zxcvbnmasdfg',
  'iloveyou1234', 'iloveyou12345', 'letmein12345', 'letmeinletmein', 'welcome12345', 'welcome123456', 'administrator',
  'adminadminadmin', 'admin1234567', 'changeme1234', 'changemechangeme', 'changeit1234', 'trustno1trustno1',
  'correcthorsebatterystaple', 'cocoon123456', 'cocooncocoon', 'cocoon1234567', 'monkey123456', 'dragon123456',
  'football1234', 'baseball1234', 'superman1234', 'sunshine1234', 'princess1234', 'starwars1234',
]);

/** Runs of keys and digits that are read off a keyboard, forwards or backwards (digits wrap around: "…890123"). */
const RUNS = [
  '1234567890'.repeat(26),
  'qwertyuiopasdfghjklzxcvbnm',
  'qwertzuiopasdfghjklyxcvbnm',
  'abcdefghijklmnopqrstuvwxyz',
].flatMap((run) => [run, [...run].reverse().join('')]);

/** "aaaaaaaaaaaa", "abababababab", "123456789012", "qwertyuiopas": long enough, but not a password. */
function isPattern(value: string): boolean {
  const chars = [...value];
  for (let unit = 1; unit <= 4; unit++) if (chars.every((char, i) => char === chars[i % unit])) return true;
  return RUNS.some((run) => run.includes(value));
}

/** What is wrong with a new password, if anything. Length counts characters, not bytes; no rules about character classes. */
export function passwordProblem(password: string, username?: string): PasswordProblem | undefined {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return 'tooShort';
  if (length > PASSWORD_MAX_LENGTH) return 'tooLong';
  const folded = password.normalize('NFKC').toLowerCase();
  if (COMMON.has(folded) || isPattern(folded)) return 'common';
  if (username && username.length >= 4 && folded.includes(username.toLowerCase())) return 'username';
  return undefined;
}
