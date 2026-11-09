import { describe, expect, it } from 'vitest';
import { methods, Settings, type CocoonEvent, type SecretInfo } from '@cocoon/protocol';
import { eventFor, mayCall, mayUseParams, METHOD_ACCESS, redactResult, redactSettings } from './access.ts';
import type { Principal } from './principal.ts';

const admin: Principal = { kind: 'token', role: 'admin', credentialId: 'token:t', name: 't' };
const member: Principal = { kind: 'user', role: 'member', credentialId: 'session:s', userId: 'us_1', username: 'alice' };
const adminUser: Principal = { kind: 'user', role: 'admin', credentialId: 'session:a', userId: 'us_2', username: 'root' };

/** Reviewed by hand: changing this list means changing what members may do. */
const ADMIN_ONLY = [
  'egress.denied',
  'image.build',
  'notifications.test',
  'providers.test',
  'secrets.delete',
  'secrets.set',
  'services.add',
  'services.credentials',
  'services.remove',
  'services.start',
  'services.stop',
  'services.test',
  'services.update',
  'settings.reset',
  'settings.update',
  'system.restart',
  'tokens.create',
  'tokens.list',
  'tokens.revoke',
  'update.apply',
  'update.status',
  'users.create',
  'users.delete',
  'users.list',
  'users.reset_password',
  'users.update',
];

describe('method access', () => {
  it('has a rule for every method and for nothing else', () => {
    expect(Object.keys(METHOD_ACCESS).sort()).toEqual(Object.keys(methods).sort());
  });

  it('keeps administration with admins', () => {
    const adminOnly = Object.entries(METHOD_ACCESS)
      .filter(([, access]) => access === 'admin')
      .map(([method]) => method)
      .sort();
    expect(adminOnly).toEqual(ADMIN_ONLY);
  });

  it('never lets members touch users, tokens, credentials, settings or updates', () => {
    for (const method of Object.keys(METHOD_ACCESS) as Array<keyof typeof METHOD_ACCESS>) {
      if (/^(users|tokens|update|settings)\.(?!get$)/.test(method) || /^secrets\.(set|delete)$/.test(method)) {
        expect(mayCall('member', method), method).toBe(false);
      }
    }
  });

  it('lets admins call everything and members the working methods', () => {
    for (const method of Object.keys(METHOD_ACCESS) as Array<keyof typeof METHOD_ACCESS>) expect(mayCall('admin', method), method).toBe(true);
    for (const method of ['sandbox.create', 'sandbox.exec', 'agent.spawn', 'task.create', 'git.push', 'files.write', 'auth.me', 'auth.logout', 'auth.change_password'] as const) {
      expect(mayCall('member', method), method).toBe(true);
    }
  });
});

describe('what members get to see', () => {
  const secrets: SecretInfo[] = [
    { name: 'ANTHROPIC_API_KEY', set: true, preview: 'sk-ant-…a1b2', source: 'store', updatedAt: '2026-01-01T00:00:00Z' },
    { name: 'OPENAI_API_KEY', set: false },
  ];

  it('reduces the list of credentials to names and whether they are set', () => {
    expect(redactResult('secrets.list', secrets, member)).toEqual([
      { name: 'ANTHROPIC_API_KEY', set: true, source: 'store' },
      { name: 'OPENAI_API_KEY', set: false, source: undefined },
    ]);
    expect(JSON.stringify(redactResult('secrets.list', secrets, member))).not.toContain('sk-ant');
  });

  it('shows admins everything', () => {
    expect(redactResult('secrets.list', secrets, admin)).toBe(secrets);
    expect(redactResult('secrets.list', secrets, adminUser)).toBe(secrets);
  });

  it('hides the notification webhook, which works like a password', () => {
    const settings = Settings.parse({ notifications: { webhookUrl: 'https://hooks.example.com/services/T000/B000/secret' } });
    const seen = redactResult('settings.get', settings, member) as Settings;
    expect(seen.notifications.webhookUrl).toBeUndefined();
    expect(seen.notifications.events).toEqual(settings.notifications.events);
    expect(seen.general).toEqual(settings.general);
    expect(redactResult('settings.get', settings, admin)).toBe(settings);
    expect(redactSettings(settings).notifications.webhookUrl).toBeUndefined();
    expect(settings.notifications.webhookUrl).toBeDefined();
  });

  it('hides credentials in the rest of the settings too, and keeps what forms need', () => {
    const settings = Settings.parse({
      providers: { gw: { label: 'Gateway', kind: 'openai', baseUrl: 'https://user:pw@gw.example.com/v1?api_key=sk-secret#x', secret: 'GW_KEY', models: ['m1'] } },
      agents: { custom: { command: ['custom'], env: { CUSTOM_API_KEY: 'sk-live-123', MODE: 'fast' } } },
    });
    const seen = redactResult('settings.get', settings, member) as Settings;
    expect(JSON.stringify(seen)).not.toMatch(/sk-live-123|sk-secret|user:pw/);
    expect(seen.agents.custom?.env).toEqual({ CUSTOM_API_KEY: '', MODE: '' });
    expect(seen.providers.gw).toMatchObject({ label: 'Gateway', baseUrl: 'https://gw.example.com/v1', secret: 'GW_KEY', models: ['m1'] });
    expect(seen.agents.custom?.command).toEqual(['custom']);
    expect(settings.agents.custom?.env.CUSTOM_API_KEY).toBe('sk-live-123');
  });

  it('leaves the results of other methods alone', () => {
    const list = [{ id: 'sb_1' }];
    expect(redactResult('sandbox.list', list, member)).toBe(list);
  });

  it('hides events about administration and removes the webhook from settings events', () => {
    const settings = Settings.parse({ notifications: { webhookUrl: 'https://hooks.example.com/services/secret' } });
    const hidden: CocoonEvent[] = [
      { type: 'update.progress', buildId: 'b', status: 'running', line: 'git pull' },
      { type: 'image.build', buildId: 'b', kind: 'sandbox', status: 'running' },
    ];
    for (const event of hidden) {
      expect(eventFor(event, member), event.type).toBeUndefined();
      expect(eventFor(event, admin), event.type).toBe(event);
    }
    const shown = eventFor({ type: 'settings.updated', settings }, member);
    expect(shown?.type === 'settings.updated' && shown.settings.notifications.webhookUrl).toBeUndefined();
    const task: CocoonEvent = { type: 'task.deleted', taskId: 't', workspaceId: 'w' };
    expect(eventFor(task, member)).toBe(task);
  });
});

describe('parameters only admins may set', () => {
  it('keeps members with the default GitHub token', () => {
    for (const method of ['sandbox.create', 'sandbox.update', 'workspace.create', 'workspace.update'] as const) {
      expect(mayUseParams('member', method, { githubToken: 'GITHUB_TOKEN_COMPANY' }), method).toBe(false);
      expect(mayUseParams('member', method, { githubToken: 'GITHUB_TOKEN' }), method).toBe(true);
      expect(mayUseParams('member', method, { githubToken: null }), method).toBe(true);
      expect(mayUseParams('member', method, {}), method).toBe(true);
      expect(mayUseParams('admin', method, { githubToken: 'GITHUB_TOKEN_COMPANY' }), method).toBe(true);
    }
    expect(mayUseParams('member', 'sandbox.list', { githubToken: 'GITHUB_TOKEN_COMPANY' })).toBe(true);
  });
});
