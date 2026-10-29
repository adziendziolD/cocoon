import { z } from 'zod';
import { cutAtAny, stripInlineComment, trimTrailing } from './strings.ts';

/**
 * Environment injection: variables defined per workspace, repository and sandbox, merged in that order
 * (later wins), then the agent type on top. Values are secrets: the API only ever returns them for variables
 * explicitly marked as not secret.
 */

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Variables CoCoon sets itself (or that would undermine the sandbox network control) cannot be overridden. */
const RESERVED = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']);
export const isReservedEnvName = (name: string) => name.startsWith('COCOON_') || RESERVED.has(name);

/** Where a variable goes: the environment of sandbox/agent processes, a .env file in the repository folder, or both. */
export const EnvTarget = z.enum(['env', 'file', 'both']);
export type EnvTarget = z.infer<typeof EnvTarget>;

export const EnvScopeKind = z.enum(['workspace', 'repo', 'sandbox']);
export type EnvScopeKind = z.infer<typeof EnvScopeKind>;

/** workspace → workspaceId, repo → repository URL, sandbox → sandboxId. */
export const EnvScopeRef = z.object({ scope: EnvScopeKind, id: z.string().min(1) });
export type EnvScopeRef = z.infer<typeof EnvScopeRef>;

/** Relative path of the .env file inside the repository folder (no "..", nothing git would treat as a pattern). */
export const ENV_FILE_PATH = /^[A-Za-z0-9._][A-Za-z0-9._-]*(\/[A-Za-z0-9._][A-Za-z0-9._-]*)*$/;
export const DEFAULT_ENV_FILE = '.env';
export const validEnvFilePath = (path: string) =>
  ENV_FILE_PATH.test(path) && path.length <= 200 && !path.split('/').some((part) => part === '.' || part === '..' || part === '.git');

const PROXY_HOST = /^(https?:\/\/)?([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(:\d{1,5})?$/;

const EnvName = z.string().regex(ENV_NAME).max(128);

export const EnvVarInput = z.object({
  name: EnvName,
  /** Omitted = keep the stored value (to change only the settings of a variable). */
  value: z.string().max(65_536).optional(),
  target: EnvTarget.optional(),
  /** false = the value is shown in the UI/API. Default: true (masked). */
  secret: z.boolean().optional(),
  /**
   * "API key for host X": the sandbox only gets a placeholder (and a base URL pointing at the credential proxy);
   * the proxy adds the real value on requests to this host. Needs an upper-case name; "" or null clears it.
   */
  proxyHost: z.string().nullable().optional(),
  /** Env var that receives the proxy base URL (default: NAME without _API_KEY/_KEY/_TOKEN/_SECRET + _BASE_URL). */
  baseUrlEnv: EnvName.nullable().optional(),
});
export type EnvVarInput = z.infer<typeof EnvVarInput>;

export const EnvVar = z.object({
  name: z.string(),
  target: EnvTarget,
  secret: z.boolean(),
  /** Only for variables that are not secret. */
  value: z.string().optional(),
  proxyHost: z.string().optional(),
  baseUrlEnv: z.string().optional(),
  updatedAt: z.string(),
});
export type EnvVar = z.infer<typeof EnvVar>;

export const EnvScopeInfo = EnvScopeRef.extend({
  /** Display name of the scope (workspace/sandbox name, normalized repository). */
  label: z.string(),
  /** .env file path inside the repository folders (default ".env"). */
  filePath: z.string().optional(),
  vars: z.array(EnvVar),
});
export type EnvScopeInfo = z.infer<typeof EnvScopeInfo>;

export const EnvOrigin = z.object({
  scope: z.enum(['workspace', 'repo', 'sandbox', 'agent']),
  id: z.string(),
  label: z.string(),
});
export type EnvOrigin = z.infer<typeof EnvOrigin>;

export const ResolvedEnvVar = z.object({
  name: z.string(),
  target: EnvTarget,
  secret: z.boolean(),
  value: z.string().optional(),
  proxyHost: z.string().optional(),
  /** Where the winning value comes from, and the lower levels it overrides (weakest first). */
  origin: EnvOrigin,
  overrides: z.array(EnvOrigin),
  /** Set when the variable is not injected, e.g. because the credential proxy is not available. */
  skipped: z.string().optional(),
});
export type ResolvedEnvVar = z.infer<typeof ResolvedEnvVar>;

export const EnvFileStatus = z.object({
  /** Repository folder ("" = the workspace folder itself) and file path inside it. */
  folder: z.string(),
  path: z.string(),
  status: z.enum(['written', 'removed', 'unchanged', 'skipped', 'error']),
  vars: z.number(),
  message: z.string().optional(),
});
export type EnvFileStatus = z.infer<typeof EnvFileStatus>;

export const ResolvedEnv = z.object({
  sandboxId: z.string(),
  agentKind: z.string().optional(),
  vars: z.array(ResolvedEnvVar),
  /** Result of the last time the .env files were written. */
  files: z.array(EnvFileStatus),
  appliedAt: z.string().optional(),
});
export type ResolvedEnv = z.infer<typeof ResolvedEnv>;

// ── repository identity ────────────────────────────────────────────────────

/**
 * Identity of a repository independent of how it was written: "https://user:pw@GitHub.com/o/r.git/",
 * "git@github.com:o/r" and "ssh://git@github.com/o/r.git" are all "github.com/o/r". Ports are dropped (ssh and https
 * reach the same repository on different ports); path case is kept.
 */
export function normalizeRepoUrl(url: string): string {
  let rest = cutAtAny(url.trim(), '?#');
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  rest = rest.replace(/^[^@/]*@/, '');
  rest = rest.replace(/^([^/:]+):(?!\d+\/)/, '$1/');
  rest = rest.replace(/^([^/:]+):\d+\//, '$1/');
  rest = trimTrailing(trimTrailing(rest, '/').replace(/\.git$/i, ''), '/');
  const [host = '', ...path] = rest.split('/');
  return [host.toLowerCase(), ...path].join('/');
}

/**
 * "API key for host X": host name with optional port, https unless "http://" is given (internal APIs).
 * Returns "api.stripe.com", "api.internal:8443" or "http://localhost:9000"; undefined if it is not a host.
 */
export function normalizeProxyHost(host: string): string | undefined {
  const match = PROXY_HOST.exec(trimTrailing(host.trim().toLowerCase(), '/'));
  if (!match) return undefined;
  const [, scheme, name = '', , , , port = ''] = match;
  if (port && Number(port.slice(1)) > 65_535) return undefined;
  return `${scheme === 'http://' ? 'http://' : ''}${name}${port}`;
}

/** Upstream URL of a normalized proxy host. */
export const proxyHostUrl = (host: string) => (host.startsWith('http://') ? host : `https://${host}`);

/** Default env var for the proxy base URL: STRIPE_API_KEY → STRIPE_BASE_URL. */
export function defaultBaseUrlEnv(name: string): string {
  const prefix = name.replace(/_(API_)?(KEY|TOKEN|SECRET)$/, '');
  return `${prefix || name}_BASE_URL`;
}

// ── .env format ────────────────────────────────────────────────────────────

export interface DotenvResult {
  vars: { name: string; value: string }[];
  /** Problems by line number – never contain values. */
  errors: { line: number; message: string }[];
}

/**
 * Parses .env content: `KEY=value`, optional `export `, comments, single quotes (literal), double quotes (with \n \t \" \\
 * escapes, may span lines) and unquoted values (trailing ` # comment` removed). Later duplicates win.
 */
export function parseDotenv(content: string): DotenvResult {
  const vars = new Map<string, string>();
  const errors: DotenvResult['errors'] = [];
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const text = raw.trim();
    if (!text || text.startsWith('#')) continue;
    const match = /^(?:export\s+)?([^=\s]+)\s*=\s*(.*)$/.exec(raw.trimStart());
    if (!match) {
      errors.push({ line: i + 1, message: 'expected NAME=value' });
      continue;
    }
    const [, name = '', rest = ''] = match;
    if (!ENV_NAME.test(name)) {
      errors.push({ line: i + 1, message: `invalid variable name "${name.slice(0, 40)}"` });
      continue;
    }
    const quote = rest[0];
    if (quote === "'") {
      const end = rest.indexOf("'", 1);
      if (end < 0) errors.push({ line: i + 1, message: 'unterminated single quote' });
      else vars.set(name, rest.slice(1, end));
    } else if (quote === '"') {
      let value = '';
      let current = rest.slice(1);
      const startLine = i;
      for (;;) {
        let closed = false;
        for (let k = 0; k < current.length; k++) {
          const c = current[k]!;
          if (c === '\\' && k + 1 < current.length) {
            const n = current[++k]!;
            value += n === 'n' ? '\n' : n === 'r' ? '\r' : n === 't' ? '\t' : n;
          } else if (c === '"') {
            closed = true;
            break;
          } else value += c;
        }
        if (closed) break;
        if (++i >= lines.length) {
          errors.push({ line: startLine + 1, message: 'unterminated double quote' });
          value = '';
          i = startLine;
          current = '';
          break;
        }
        value += '\n';
        current = lines[i]!;
      }
      if (!errors.some((e) => e.line === startLine + 1)) vars.set(name, value);
    } else {
      vars.set(name, stripInlineComment(rest).trim());
    }
  }
  return { vars: [...vars].map(([name, value]) => ({ name, value })), errors };
}

/** Renders variables as .env content that parseDotenv() (and common dotenv loaders) read back unchanged. */
export function renderDotenv(vars: { name: string; value: string }[], header?: string): string {
  const quote = (value: string) => {
    if (/^[A-Za-z0-9_@%+=:,./-]*$/.test(value)) return value;
    if (!/['\n\r\\]/.test(value)) return `'${value}'`;
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
  };
  return `${header ? `${header}\n` : ''}${vars.map((v) => `${v.name}=${quote(v.value)}\n`).join('')}`;
}
