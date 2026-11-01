import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/** Opt-in for webhook receivers on private networks (e.g. a self-hosted Mattermost): COCOON_ALLOW_PRIVATE_WEBHOOKS=1. */
export const ALLOW_PRIVATE_WEBHOOKS_ENV = 'COCOON_ALLOW_PRIVATE_WEBHOOKS';

export class BlockedTargetError extends Error {
  constructor(readonly target: string) {
    super(`target ${target} is a private, loopback or link-local address`);
  }
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses (IPv4 and IPv6). */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
  if (isIP(ip) === 4) {
    const [a = 0, b = 0, c = 0] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(ip) === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip) ?? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
    if (mapped) {
      if (mapped[2] === undefined) return isPrivateAddress(mapped[1]!);
      const hi = parseInt(mapped[1]!, 16);
      const lo = parseInt(mapped[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const first = parseInt(ip.split(':')[0] || '0', 16);
    return (
      ip === '::' ||
      ip === '::1' ||
      (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
      (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
      (first & 0xff00) === 0xff00 || // multicast
      ip.startsWith('64:ff9b:') || // NAT64: reaches arbitrary IPv4 hosts
      ip.startsWith('2002:') // 6to4
    );
  }
  return true;
}

/** dns.lookup that refuses to resolve to a private address (checked at connect time, so DNS rebinding cannot swap it afterwards). */
function guardedLookup(hostname: string, options: { all?: boolean; family?: number }, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '');
    if (addresses.some((a) => isPrivateAddress(a.address))) return callback(new BlockedTargetError(hostname), '');
    if (options.all) return callback(null, addresses);
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
}

export interface PostOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Allow private/loopback targets (default: from COCOON_ALLOW_PRIVATE_WEBHOOKS). */
  allowPrivate?: boolean;
}

/**
 * POSTs JSON to a user-supplied URL (webhooks) without letting it reach internal services: http/https only, private
 * addresses are refused (also after DNS resolution), redirects are not followed. Resolves with the HTTP status.
 */
export function postJson(url: string, body: unknown, options: PostOptions = {}): Promise<number> {
  const allowPrivate = options.allowPrivate ?? process.env[ALLOW_PRIVATE_WEBHOOKS_ENV] === '1';
  return new Promise((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return reject(new Error('invalid URL'));
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return reject(new Error('only http and https URLs are allowed'));
    if (!allowPrivate && isIP(target.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(target.hostname)) return reject(new BlockedTargetError(target.hostname));
    const payload = Buffer.from(JSON.stringify(body));
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      target,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length, ...options.headers },
        timeout: options.timeoutMs ?? 10_000,
        ...(allowPrivate ? {} : { lookup: guardedLookup as never }),
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', reject);
        res.on('close', () => reject(new Error('connection closed before the response ended')));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    // The socket timeout only covers idle time; this one also stops a receiver that keeps the response open.
    const overall = setTimeout(() => req.destroy(new Error('timeout')), (options.timeoutMs ?? 10_000) * 2);
    overall.unref();
    req.on('close', () => clearTimeout(overall));
    req.on('error', reject);
    req.end(payload);
  });
}
