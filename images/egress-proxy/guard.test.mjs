import net from 'node:net';
import tls from 'node:tls';
import { describe, expect, it } from 'vitest';
import { evaluateTarget, guardedLookup, isPrivateAddress, parseAuthority, peekClientHello, sniMatches } from './guard.mjs';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '127.255.255.254', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '169.254.0.1', '100.64.0.1', '100.127.255.255', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1',
    '::', '::1', 'fe80::1', 'fe80::abcd%eth0', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::1', '2002:a9fe:a9fe::1', '2001:db8::1', '::127.0.0.1',
    '[::1]', 'not-an-ip', '',
  ])('refuses %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '140.82.112.3', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.0.1', '192.0.1.1', '198.20.0.1',
    '2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])('accepts public %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('evaluateTarget', () => {
  const policy = {
    allowlist: ['example.com', '*.github.com', 'internal.corp'],
    allowPrivate: ['internal.corp'],
    targets: [{ host: 'host.docker.internal', port: 11434 }, { host: '::1', port: 8080 }],
  };

  it('allows allowlisted names on 80/443 only, public addresses only', () => {
    expect(evaluateTarget(policy, 'example.com', 443)).toEqual({ allowed: true, allowPrivate: false });
    expect(evaluateTarget(policy, 'EXAMPLE.com.', 80)).toEqual({ allowed: true, allowPrivate: false });
    expect(evaluateTarget(policy, 'api.github.com', 443)).toEqual({ allowed: true, allowPrivate: false });
    expect(evaluateTarget(policy, 'example.com', 8443).allowed).toBe(false);
    expect(evaluateTarget(policy, 'evil.com', 443).allowed).toBe(false);
    expect(evaluateTarget(policy, 'github.com.evil.com', 443).allowed).toBe(false);
  });

  it('allows private addresses only for explicit entries', () => {
    expect(evaluateTarget(policy, 'internal.corp', 443)).toEqual({ allowed: true, allowPrivate: true });
    expect(evaluateTarget(policy, 'host.docker.internal', 11434)).toEqual({ allowed: true, allowPrivate: true });
    expect(evaluateTarget(policy, '[::1]', 8080)).toEqual({ allowed: true, allowPrivate: true });
  });

  it('allows a target on its own port only, not on 80/443', () => {
    expect(evaluateTarget(policy, 'host.docker.internal', 80).allowed).toBe(false);
    expect(evaluateTarget(policy, 'host.docker.internal', 443).allowed).toBe(false);
    expect(evaluateTarget(policy, 'host.docker.internal', 5432).allowed).toBe(false);
  });

  it('tolerates a policy without the optional lists', () => {
    expect(evaluateTarget({ allowlist: ['example.com'] }, 'example.com', 443).allowed).toBe(true);
    expect(evaluateTarget({}, 'example.com', 443).allowed).toBe(false);
  });
});

describe('parseAuthority', () => {
  it('parses host, host:port and bracketed IPv6', () => {
    expect(parseAuthority('Example.com:8443', 443)).toEqual({ host: 'example.com', port: 8443 });
    expect(parseAuthority('example.com', 443)).toEqual({ host: 'example.com', port: 443 });
    expect(parseAuthority('[::1]:8080', 443)).toEqual({ host: '::1', port: 8080 });
    expect(parseAuthority('[2606:4700::1111]', 443)).toEqual({ host: '2606:4700::1111', port: 443 });
  });

  it('rejects malformed input', () => {
    for (const bad of ['', ':443', 'host:0', 'host:70000', 'host:abc', 'a:b:c', '[::1', 'host name:1']) expect(parseAuthority(bad, 443)).toBeUndefined();
  });
});

describe('guardedLookup', () => {
  const resolver = (addresses) => (_host, _options, cb) => cb(null, addresses);
  const run = (lookup, host, options = { all: true }) => new Promise((resolve) => lookup(host, options, (err, a, f) => resolve({ err, a, f })));

  it('refuses a name that resolves to a private address, even if other results are public', async () => {
    const lookup = guardedLookup({ allowPrivate: false, resolve: resolver([{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]) });
    const { err } = await run(lookup, 'rebind.example.com');
    expect(err?.code).toBe('ECOCOON_PRIVATE');
  });

  it('refuses a name that resolves to the host gateway or loopback', async () => {
    for (const address of ['172.17.0.1', '127.0.0.1', '::1', '192.168.0.10']) {
      const { err } = await run(guardedLookup({ allowPrivate: false, resolve: resolver([{ address, family: address.includes(':') ? 6 : 4 }]) }), 'host.docker.internal');
      expect(err?.code).toBe('ECOCOON_PRIVATE');
    }
  });

  it('returns the checked addresses of a public name (all and single form)', async () => {
    const addresses = [{ address: '140.82.112.3', family: 4 }];
    const lookup = guardedLookup({ allowPrivate: false, resolve: resolver(addresses) });
    expect((await run(lookup, 'github.com')).a).toEqual(addresses);
    expect(await run(lookup, 'github.com', {})).toMatchObject({ err: null, a: '140.82.112.3', f: 4 });
  });

  it('allows private results when explicitly permitted', async () => {
    const lookup = guardedLookup({ allowPrivate: true, resolve: resolver([{ address: '172.17.0.1', family: 4 }]) });
    expect((await run(lookup, 'host.docker.internal')).err).toBeNull();
  });

  it('passes resolver errors on', async () => {
    const lookup = guardedLookup({ allowPrivate: false, resolve: (_h, _o, cb) => cb(Object.assign(new Error('nx'), { code: 'ENOTFOUND' })) });
    expect((await run(lookup, 'nx.example')).err?.code).toBe('ENOTFOUND');
  });
});

/** Captures the ClientHello a real TLS client (Node) sends. */
async function clientHello(servername) {
  const server = net.createServer((socket) => {
    socket.once('data', (data) => {
      captured(data);
      socket.destroy();
    });
  });
  let captured;
  const got = new Promise((resolve) => (captured = resolve));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = tls.connect({ host: '127.0.0.1', port: server.address().port, servername, rejectUnauthorized: false });
  client.on('error', () => undefined);
  const data = await got;
  client.destroy();
  server.close();
  return data;
}

/** Minimal ClientHello body builder for edge cases. */
function hello({ extensions = [], sessionId = Buffer.alloc(0) } = {}) {
  const u16 = (n) => Buffer.from([n >> 8, n & 255]);
  const ext = Buffer.concat(extensions.map(([type, data]) => Buffer.concat([u16(type), u16(data.length), data])));
  const body = Buffer.concat([u16(0x0303), Buffer.alloc(32), Buffer.from([sessionId.length]), sessionId, u16(2), u16(0x1301), Buffer.from([1, 0]), u16(ext.length), ext]);
  const handshake = Buffer.concat([Buffer.from([1, 0, body.length >> 8, body.length & 255]), body]);
  return handshake;
}
const record = (payload) => Buffer.concat([Buffer.from([0x16, 3, 1, payload.length >> 8, payload.length & 255]), payload]);
const sniExt = (name) => {
  const n = Buffer.from(name);
  const list = Buffer.concat([Buffer.from([0, n.length >> 8, n.length & 255]), n]);
  return [0, Buffer.concat([Buffer.from([list.length >> 8, list.length & 255]), list])];
};

describe('peekClientHello', () => {
  it('reads the SNI of a real TLS client hello', async () => {
    expect(peekClientHello(await clientHello('api.github.com'))).toEqual({ status: 'ok', sni: 'api.github.com' });
  });

  it('reports a missing SNI as null', async () => {
    expect(peekClientHello(await clientHello(''))).toEqual({ status: 'ok', sni: null });
    expect(peekClientHello(record(hello()))).toEqual({ status: 'ok', sni: null });
  });

  it('asks for more data on a partial hello at every cut', async () => {
    const data = await clientHello('example.com');
    for (let cut = 0; cut < data.length; cut += 7) expect(peekClientHello(data.subarray(0, cut)).status).toBe('more');
  });

  it('reassembles a hello split over several records', () => {
    const body = hello({ extensions: [sniExt('split.example.com')] });
    const data = Buffer.concat([record(body.subarray(0, 20)), record(body.subarray(20, 60)), record(body.subarray(60))]);
    expect(peekClientHello(data)).toEqual({ status: 'ok', sni: 'split.example.com' });
  });

  it('rejects anything that is not a ClientHello', () => {
    expect(peekClientHello(Buffer.from('GET / HTTP/1.1\r\nHost: github.com\r\n\r\n')).status).toBe('invalid');
    expect(peekClientHello(Buffer.from('SSH-2.0-OpenSSH_9.0\r\n')).status).toBe('invalid');
    expect(peekClientHello(record(Buffer.from([2, 0, 0, 2, 1, 40]))).status).toBe('invalid'); // alert/server hello type
    expect(peekClientHello(Buffer.from([0x16, 3, 1, 0xff, 0xff, 1])).status).toBe('invalid'); // record larger than 16 KiB
  });

  it('rejects truncated and ambiguous hellos', () => {
    expect(peekClientHello(record(hello({ extensions: [sniExt('a.example.com'), sniExt('b.example.com')] }))).status).toBe('invalid');
    const twoNames = (() => {
      const [, one] = sniExt('a.example.com');
      const [, two] = sniExt('b.example.com');
      const list = Buffer.concat([one.subarray(2), two.subarray(2)]);
      return [0, Buffer.concat([Buffer.from([list.length >> 8, list.length & 255]), list])];
    })();
    expect(peekClientHello(record(hello({ extensions: [twoNames] }))).status).toBe('invalid');
    const lying = hello({ extensions: [[0, Buffer.from([0, 200, 0, 0, 5, 1, 2])]] });
    expect(peekClientHello(record(lying)).status).toBe('invalid');
  });
});

describe('sniMatches', () => {
  it('requires the SNI to equal the CONNECT host (case and trailing dot ignored)', () => {
    expect(sniMatches('api.github.com', 'api.github.com')).toBe(true);
    expect(sniMatches('API.GitHub.com.', 'api.github.com')).toBe(true);
    expect(sniMatches('evil.githubusercontent.com', 'raw.githubusercontent.com')).toBe(false);
    expect(sniMatches(null, 'api.github.com')).toBe(false);
    expect(sniMatches('', 'api.github.com')).toBe(false);
  });

  it('expects no SNI for IP literals', () => {
    expect(sniMatches(null, '140.82.112.3')).toBe(true);
    expect(sniMatches('github.com', '140.82.112.3')).toBe(false);
    expect(sniMatches(null, '2606:4700::1111')).toBe(true);
  });
});
