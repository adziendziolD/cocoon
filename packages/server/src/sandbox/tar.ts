/** Builds a minimal single-file ustar archive (enough for Docker's putArchive). */
export function singleFileTar(name: string, content: Buffer, opts: { uid: number; gid: number; mode?: number }): Buffer {
  const header = Buffer.alloc(512);
  const write = (value: string, offset: number, length: number) => header.write(value, offset, length, 'utf8');
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0') + '\0';

  if (Buffer.byteLength(name) > 100) throw new Error('file name too long');
  write(name, 0, 100);
  write(octal(opts.mode ?? 0o644, 8), 100, 8);
  write(octal(opts.uid, 8), 108, 8);
  write(octal(opts.gid, 8), 116, 8);
  write(octal(content.length, 12), 124, 12);
  write(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  write('        ', 148, 8);
  write('0', 156, 1);
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);

  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding, Buffer.alloc(1024)]);
}
