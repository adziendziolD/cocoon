import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILES, type AgentProfile } from '@cocoon/protocol';
import type { SandboxRecord } from '../store.ts';
import { AgentManager } from './manager.ts';

/** What reaches an agent's environment: who can open a shell in the sandbox (sandbox.exec) can read all of it. */
type Internals = {
  secretEnv(profile: AgentProfile, sandbox: SandboxRecord, kinds: Set<string>, grants: Set<string>): Record<string, string>;
  wireProviders(profile: AgentProfile, ids: string[], model: string | undefined, sandbox: SandboxRecord): Promise<{ env: Record<string, string> }>;
};

const REAL: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-REAL-anthropic-key',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-REAL-subscription-token',
  GITHUB_TOKEN: 'ghp_REAL_github_token',
  MOCK_API_KEY: 'REAL-provider-key',
};

function manager(credentialProxy = true): Internals {
  const settings = { get: () => ({ egress: { credentialProxy } }) };
  const secrets = { resolve: (name: string) => REAL[name], githubToken: () => REAL.GITHUB_TOKEN };
  const providers = {
    get: () => ({ kind: 'http', label: 'Mock', baseUrl: 'http://mock.example.com/v1', secret: 'MOCK_API_KEY', auth: 'bearer', models: [] }),
    key: () => REAL.MOCK_API_KEY,
  };
  const egress = { credentialUrl: (_sandbox: unknown, route: string) => `http://cocoon-proxy:8080/${route}` };
  return new AgentManager(settings as never, secrets as never, providers as never, {} as never, {} as never, {} as never, {} as never, egress as never, {} as never, {} as never, () => undefined) as unknown as Internals;
}

const sandbox = (network: SandboxRecord['network']) => ({ id: 'sb_1', name: 'dev', network, proxyToken: 'tok123' }) as SandboxRecord;
const claude = DEFAULT_PROFILES['claude-code']!;
const everything = (env: Record<string, string>) => JSON.stringify(env);

describe('credentials in the environment of an agent', () => {
  it('replaces the model keys by placeholders when the sandbox has a network (credential proxy)', () => {
    const env = manager().secretEnv(claude, sandbox('egress'), new Set(), new Set());
    expect(env.ANTHROPIC_API_KEY).toBe('cocoon_tok123_ANTHROPIC_API_KEY');
    expect(everything(env)).not.toContain('sk-ant-REAL');
    // Documented limit: the GitHub token cannot be proxied and is in the environment.
    expect(env.GITHUB_TOKEN).toBe(REAL.GITHUB_TOKEN);
  });

  it('puts no credential at all into a sandbox without a network: it would be of no use and readable by anyone with a shell there', () => {
    const env = manager().secretEnv(claude, sandbox('none'), new Set(), new Set());
    expect(env).toEqual({});
  });

  it('leaves the choice to the admin when the credential proxy is switched off', () => {
    const env = manager(false).secretEnv(claude, sandbox('egress'), new Set(), new Set());
    expect(env.ANTHROPIC_API_KEY).toBe(REAL.ANTHROPIC_API_KEY);
  });

  it('gives the key of an HTTP provider as a placeholder, and none without a network', async () => {
    const withNetwork = await manager().wireProviders(claude, ['mock'], undefined, sandbox('egress'));
    expect(Object.values(withNetwork.env)).toContain('cocoon_tok123_MOCK_API_KEY');
    expect(everything(withNetwork.env)).not.toContain('REAL-provider-key');

    const offline = await manager().wireProviders(claude, ['mock'], undefined, sandbox('none'));
    expect(everything(offline.env)).not.toContain('REAL-provider-key');
    expect(everything(offline.env)).not.toContain('MOCK_API_KEY');
  });
});
