/** Splits a command line into arguments, respecting single/double quotes and backslash escapes. */
export function splitCommand(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let hasToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      // In double quotes a backslash only escapes $ ` " \ and newline (POSIX); before anything else it stays.
      else if (ch === '\\' && quote === '"' && i + 1 < input.length && '$`"\\\n'.includes(input[i + 1]!)) cur += input[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
    } else if (ch === '\\' && i + 1 < input.length) {
      cur += input[++i];
      hasToken = true;
    } else if (/\s/.test(ch)) {
      if (hasToken) out.push(cur);
      cur = '';
      hasToken = false;
    } else {
      cur += ch;
      hasToken = true;
    }
  }
  if (hasToken) out.push(cur);
  return out;
}

/** Inverse of splitCommand, quoting arguments only when needed. */
export function joinCommand(args: string[]): string {
  return args
    .map((a) => (a === '' ? "''" : /[\s"'\\$`]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a))
    .join(' ');
}
