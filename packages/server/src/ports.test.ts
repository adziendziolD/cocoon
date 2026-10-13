import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript module of the gateway container
import { parsePorts } from '../../../images/port-gateway/gateway.mjs';
import { parseListening, parsePreviewHost, parseRange, previewLabel } from './ports.ts';

const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1
   1: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1
   2: 0100007F:0BB8 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 3 1
   3: 0500590A:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4 1
   4: 0B00007F:8285 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5 1
   5: 0201007F:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 6 1
`;
const TCP6 = `  sl  local_address                         remote_address                        st
   0: 00000000000000000000000000000000:1435 00000000000000000000000000000000:0000 0A
   1: 00000000000000000000000001000000:1F41 00000000000000000000000000000000:0000 0A
   2: 0000000000000000FFFF00000100007F:1F40 00000000000000000000000000000000:0000 0A
`;

describe('parseListening', () => {
  it('finds listening ports and whether they are reachable from outside the sandbox', () => {
    expect(parseListening(TCP + TCP6)).toEqual([
      { port: 3000, address: 'loopback' }, // 127.0.0.1:3000 (the established connection is ignored)
      { port: 5173, address: 'all' }, // 0.0.0.0 and :: on 5173
      { port: 8000, address: 'loopback' }, // ::ffff:127.0.0.1
      { port: 8001, address: 'loopback' }, // ::1
      { port: 8080, address: 'all' }, // bound to the container's own address
      { port: 9000, address: 'loopback' }, // 127.0.1.2 is loopback too; Docker's DNS on 127.0.0.11 is left out
    ]);
  });

  it('lets "all" win when a port is bound to loopback and to all addresses', () => {
    const both = TCP.replace('0500590A:1F90', '00000000:0BB8');
    expect(parseListening(both).find((p) => p.port === 3000)).toEqual({ port: 3000, address: 'all' });
  });

  it('ignores garbage', () => {
    expect(parseListening('')).toEqual([]);
    expect(parseListening('cat: /proc/net/tcp6: No such file or directory')).toEqual([]);
  });
});

describe('port ranges', () => {
  it('expands ranges and single ports', () => {
    expect(parseRange('7500-7502,7600')).toEqual([7500, 7501, 7502, 7600]);
    expect(parsePorts('7500-7502, 7600')).toEqual([7500, 7501, 7502, 7600]);
  });

  it('rejects invalid ranges', () => {
    expect(() => parseRange('7502-7500')).toThrow(/invalid/);
    expect(() => parseRange('0-10')).toThrow(/invalid/);
    expect(() => parsePorts('abc')).toThrow(/invalid/);
  });
});

describe('preview host names', () => {
  it('round-trips sandbox id and port without underscores', () => {
    const label = previewLabel('sb_3f9a1c2b4d5e', 5173);
    expect(label).toBe('p5173-3f9a1c2b4d5e');
    expect(parsePreviewHost(`${label}.localhost:7420`, 'localhost')).toEqual({ sandboxId: 'sb_3f9a1c2b4d5e', port: 5173 });
    expect(parsePreviewHost(`${label.toUpperCase()}.Preview.Example.com`, 'preview.example.com')).toEqual({ sandboxId: 'sb_3f9a1c2b4d5e', port: 5173 });
  });

  it('only accepts the configured suffix', () => {
    expect(parsePreviewHost('p5173-3f9a1c2b4d5e.evil.com', 'localhost')).toBeUndefined();
    expect(parsePreviewHost('localhost:7420', 'localhost')).toBeUndefined();
    expect(parsePreviewHost(undefined, 'localhost')).toBeUndefined();
  });
});
