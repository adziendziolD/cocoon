// Destination checks of the forward proxy (dependency-free, no side effects, unit-tested):
// policy matching, private-address detection, a DNS lookup that refuses private results, and a TLS ClientHello parser
// that extracts the SNI so a CONNECT tunnel cannot be used for domain fronting.
import dns from 'node:dns';
import net from 'node:net';

export const ALLOWED_PORTS = new Set([80, 443]);

/** Lower case, no trailing dot, no IPv6 brackets. */
export const normalizeHost = (host) => host.toLowerCase().replace(/\.$/, '').replace(/^\[(.*)\]$/, '$1');

/** Splits "host", "host:port" or "[v6]:port"; undefined if malformed. */
export function parseAuthority(text, defaultPort) {
  const m = /^(?:\[([^\]\s]+)\]|([^\s:[\]]+))(?::(\d{1,5}))?$/.exec(text.trim());
  if (!m) return undefined;
  const port = m[3] === undefined ? defaultPort : Number(m[3]);
  if (!(port >= 1 && port <= 65535)) return undefined;
  return { host: normalizeHost(m[1] ?? m[2]), port };
}

function matchesPattern(pattern, host) {
  const p = pattern.toLowerCase().trim().replace(/\.$/, '').replace(/^\[(.*)\]$/, '$1');
  return p.startsWith('*.') ? host.endsWith(p.slice(1)) : host === p;
}

/**
 * What the policy says about a destination.
 * - `policy.targets` ([{ host, port }]): exact host and port, e.g. a model provider on the CoCoon host. Private
 *   addresses are acceptable there because an administrator configured the endpoint.
 * - `policy.allowlist` (domains, "*.example.com"): ports 80 and 443 only, public addresses only unless the host also
 *   matches `policy.allowPrivate`.
 */
export function evaluateTarget(policy, rawHost, port) {
  const host = normalizeHost(rawHost);
  if ((policy.targets ?? []).some((t) => normalizeHost(t.host) === host && Number(t.port) === port)) return { allowed: true, allowPrivate: true };
  if (!ALLOWED_PORTS.has(port) || !(policy.allowlist ?? []).some((p) => matchesPattern(p, host))) return { allowed: false, allowPrivate: false };
  return { allowed: true, allowPrivate: (policy.allowPrivate ?? []).some((p) => matchesPattern(p, host)) };
}

// ── addresses ─────────────────────────────────────────────────────────────────
function v4Bytes(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return undefined;
  return parts.map(Number);
}

function v6Bytes(text) {
  let ip = text.split('%')[0].toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) {
    const b = v4Bytes(dotted[1]);
    if (!b) return undefined;
    ip = `${ip.slice(0, -dotted[1].length)}${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

function privateV4([a, b, c]) {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata (169.254.169.254)
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** True for loopback, private, link-local, unique-local, multicast, reserved and unparseable addresses (fails closed). */
export function isPrivateAddress(address) {
  const ip = normalizeHost(address);
  if (net.isIPv4(ip)) return privateV4(v4Bytes(ip));
  if (!net.isIPv6(ip)) return true;
  const b = v6Bytes(ip);
  if (!b) return true;
  const zero = (from, to) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 12)) return privateV4(b.slice(12)); // ::, ::1, IPv4-compatible
  if (zero(0, 10) && b[10] === 255 && b[11] === 255) return privateV4(b.slice(12)); // ::ffff:a.b.c.d
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return zero(4, 12) ? privateV4(b.slice(12)) : true; // NAT64 (64:ff9b::/96; the local-use /48 is refused)
  if (b[0] === 0x20 && b[1] === 0x02) return privateV4(b.slice(2, 6)); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2] === 0 || (b[2] === 0x0d && b[3] === 0xb8))) return true; // Teredo, documentation
  if (b[0] === 0x01 && zero(1, 8)) return true; // discard prefix
  return b[0] === 0xff || (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80);
}

/**
 * `lookup` option for net.connect / http.request: resolves the name and refuses the connection if any result is
 * private (unless allowed). The connection uses exactly the addresses checked here, so a second lookup cannot
 * return something else (DNS rebinding). IP literals bypass lookup; check them with isPrivateAddress first.
 */
export function guardedLookup({ allowPrivate, resolve = dns.lookup }) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') [options, callback] = [{}, options];
    if (typeof options === 'number') options = { family: options };
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const bad = allowPrivate ? undefined : addresses.find((a) => isPrivateAddress(a.address));
      if (bad) {
        return callback(Object.assign(new Error(`${hostname} resolves to a private address (${bad.address})`), { code: 'ECOCOON_PRIVATE' }));
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

// ── TLS ClientHello ───────────────────────────────────────────────────────────
const MAX_HELLO = 32 * 1024;

/**
 * Parses the start of a TLS connection and returns { status: 'more' } (incomplete), { status: 'invalid' } (not a
 * ClientHello, truncated or ambiguous) or { status: 'ok', sni } (sni is null when the extension is missing).
 * The hello may span several handshake records.
 */
export function peekClientHello(buf) {
  let pos = 0;
  let handshake = Buffer.alloc(0);
  for (;;) {
    if (buf.length - pos < 5) return { status: 'more' };
    if (buf[pos] !== 0x16 || buf[pos + 1] !== 3) return { status: 'invalid' };
    const length = buf.readUInt16BE(pos + 3);
    if (length === 0 || length > 16384) return { status: 'invalid' };
    if (buf.length - pos - 5 < length) return { status: 'more' };
    handshake = Buffer.concat([handshake, buf.subarray(pos + 5, pos + 5 + length)]);
    pos += 5 + length;
    if (handshake.length < 4) continue;
    if (handshake[0] !== 1) return { status: 'invalid' };
    const size = handshake.readUIntBE(1, 3);
    if (size > MAX_HELLO) return { status: 'invalid' };
    if (handshake.length >= 4 + size) return parseHello(handshake.subarray(4, 4 + size));
  }
}

function parseHello(body) {
  let p = 34; // version + random
  const need = (n) => p + n <= body.length;
  const skip8 = () => need(1) && ((p += 1 + body[p]), p <= body.length);
  const skip16 = () => need(2) && ((p += 2 + body.readUInt16BE(p)), p <= body.length);
  if (!(skip8() && skip16() && skip8())) return { status: 'invalid' }; // session id, cipher suites, compression
  if (p === body.length) return { status: 'ok', sni: null };
  if (!need(2)) return { status: 'invalid' };
  const end = p + 2 + body.readUInt16BE(p);
  p += 2;
  if (end > body.length) return { status: 'invalid' };
  let sni = null;
  while (p < end) {
    if (p + 4 > end) return { status: 'invalid' };
    const type = body.readUInt16BE(p);
    const size = body.readUInt16BE(p + 2);
    const next = p + 4 + size;
    if (next > end) return { status: 'invalid' };
    if (type === 0) {
      if (sni !== null) return { status: 'invalid' }; // two SNI extensions
      let q = p + 4;
      if (q + 2 > next) return { status: 'invalid' };
      const listEnd = q + 2 + body.readUInt16BE(q);
      q += 2;
      if (listEnd > next) return { status: 'invalid' };
      while (q < listEnd) {
        if (q + 3 > listEnd) return { status: 'invalid' };
        const nameType = body[q];
        const nameLength = body.readUInt16BE(q + 1);
        if (q + 3 + nameLength > listEnd) return { status: 'invalid' };
        if (nameType === 0) {
          if (sni !== null) return { status: 'invalid' }; // two host names
          sni = body.toString('latin1', q + 3, q + 3 + nameLength);
        }
        q += 3 + nameLength;
      }
      if (sni === null) sni = ''; // extension present but empty: never matches
    }
    p = next;
  }
  return { status: 'ok', sni };
}

/** Whether a ClientHello's SNI is acceptable for a CONNECT to `host`: it must name exactly that host. */
export function sniMatches(sni, host) {
  const target = normalizeHost(host);
  // IP literals have no SNI (RFC 6066); anything else would be an attempt to reach a different virtual host.
  if (net.isIP(target)) return sni === null;
  return sni !== null && normalizeHost(sni) === target;
}
