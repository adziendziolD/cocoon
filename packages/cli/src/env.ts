import type { EnvScopeRef } from '@cocoon/protocol';

export interface ScopeOptions {
  workspace?: string;
  repo?: string;
  sandbox?: string;
}

/** Exactly one of --workspace / --repo / --sandbox. */
export function scopeFrom(o: ScopeOptions): EnvScopeRef {
  const given = (['workspace', 'repo', 'sandbox'] as const).filter((k) => o[k]);
  if (given.length !== 1) throw new Error('give exactly one of --workspace <id>, --repo <url> or --sandbox <id>');
  const scope = given[0]!;
  return { scope, id: o[scope]! };
}

/** "NAME=value" arguments; the value may be empty or contain "=". */
export function parseAssignments(args: string[]): { name: string; value: string }[] {
  return args.map((arg) => {
    const eq = arg.indexOf('=');
    if (eq < 1) throw new Error(`expected NAME=value, got "${arg.slice(0, eq < 0 ? 20 : eq)}" (use --stdin for a single value from standard input)`);
    return { name: arg.slice(0, eq), value: arg.slice(eq + 1) };
  });
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
