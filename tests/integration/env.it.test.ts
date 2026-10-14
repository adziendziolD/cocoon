import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { available, createSandbox, docker, rpc, sh, waitFor } from './harness.ts';

const HELLO = 'https://github.com/octocat/Hello-World.git';
/** Spellings of the same repository: the repository level must find it whichever way the sandbox cloned it. */
const HELLO_ALIAS = 'git@github.com:octocat/Hello-World';

const tag = Math.random().toString(16).slice(2, 8);
const SECRET = `sk_test_secret_${tag}`;
const PROXY_SECRET = `sk_live_proxied_${tag}`;
const BASIC_SECRET = `sk_basic_proxied_${tag}`;

/** Fake API on the host: records the credentials of every request. */
function fakeApi() {
  const requests: { path: string; auth?: string }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    requests.push({ path: req.url ?? '', auth: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'text/plain' }).end('pong');
  });
  return { server, requests };
}

/** Prints variables of a fresh agent shell between markers and returns what it printed. */
async function agentEnv(sandboxId: string, names: string[], opts: { kind?: string } = {}): Promise<Record<string, string>> {
  const agent = await rpc('agent.spawn', { sandboxId, kind: opts.kind ?? 'shell' });
  const marker = `END-${Math.random().toString(16).slice(2, 8)}`;
  const script = names.map((n) => `echo "${n}=\${${n}-<unset>}"`).join('; ');
  await rpc('agent.send_input', { agentId: agent.id, text: `${script}; echo ${marker}` });
  const screen = await waitFor('agent output', async () => {
    const { text } = await rpc('agent.read', { agentId: agent.id, lines: 80 });
    return new RegExp(`^${marker}$`, 'm').test(text) && text;
  }, 60_000);
  await rpc('agent.kill', { agentId: agent.id });
  return Object.fromEntries(
    names.map((n) => [n, new RegExp(`^${n}=(.*)$`, 'm').exec(screen)?.[1]?.trim() ?? '<missing>']),
  );
}

describe.runIf(available)('.env injection: levels, files, masking and the credential proxy', () => {
  let api: ReturnType<typeof fakeApi>;
  let apiPort: number;
  let workspaceId: string;
  let sandboxId: string;

  beforeAll(async () => {
    api = fakeApi();
    // 0.0.0.0: the proxy container reaches the host through the Docker host gateway.
    await new Promise<void>((resolve) => api.server.listen(0, '0.0.0.0', resolve));
    apiPort = (api.server.address() as AddressInfo).port;

    const settings = await rpc('settings.get');
    await rpc('settings.update', {
      agents: { ...settings.agents, 'env-probe': { command: ['bash'], env: { LEVEL: 'agent-type' } } },
    });

    workspaceId = (await rpc('workspace.create', { name: `env-${tag}` })).id;
    // Defined before the sandbox exists: the workspace and repository levels apply from the first moment.
    await rpc('env.set', {
      scope: 'workspace',
      id: workspaceId,
      vars: [
        { name: 'LEVEL', value: 'workspace' },
        { name: 'WS_ONLY', value: 'from-workspace' },
        { name: 'FILE_SECRET', value: SECRET, target: 'file' },
        { name: 'FLAG', value: 'on', secret: false, target: 'both' },
      ],
    });
    await rpc('env.set', {
      scope: 'repo',
      id: HELLO_ALIAS,
      vars: [
        { name: 'LEVEL', value: 'repository' },
        { name: 'REPO_ONLY', value: 'from-repository' },
        { name: 'PING_KEY', value: PROXY_SECRET, proxyHost: `http://localhost:${apiPort}`, target: 'both' },
        { name: 'BASIC_KEY', value: BASIC_SECRET, proxyHost: `http://localhost:${apiPort}` },
      ],
    });
    sandboxId = (await createSandbox({ name: 'env', workspaceId, repo: { url: HELLO } })).id;
    await rpc('env.set', { scope: 'sandbox', id: sandboxId, vars: [{ name: 'LEVEL', value: 'sandbox' }, { name: 'SB_ONLY', value: 'from-sandbox' }] });
  });

  afterAll(async () => {
    if (sandboxId) await rpc('sandbox.delete', { sandboxId }).catch(() => undefined);
    if (workspaceId) await rpc('workspace.delete', { workspaceId }).catch(() => undefined);
    await rpc('env.unset', { scope: 'repo', id: HELLO_ALIAS, names: ['LEVEL', 'REPO_ONLY', 'PING_KEY', 'BASIC_KEY'] }).catch(() => undefined);
    api?.server.close();
  });

  it('agents see the merged variables: workspace < repository < sandbox < agent type', async () => {
    const seen = await agentEnv(sandboxId, ['LEVEL', 'WS_ONLY', 'REPO_ONLY', 'SB_ONLY', 'FLAG', 'FILE_SECRET']);
    expect(seen).toEqual({
      LEVEL: 'sandbox',
      WS_ONLY: 'from-workspace',
      REPO_ONLY: 'from-repository',
      SB_ONLY: 'from-sandbox',
      FLAG: 'on',
      FILE_SECRET: '<unset>', // target "file" only: not in the environment
    });
    expect((await agentEnv(sandboxId, ['LEVEL'], { kind: 'env-probe' })).LEVEL).toBe('agent-type');
  });

  it('shows the merged view with the origin of every value, without secrets', async () => {
    const resolved = await rpc('env.resolve', { sandboxId, agentKind: 'env-probe' });
    const by = Object.fromEntries(resolved.vars.map((v: { name: string }) => [v.name, v]));
    expect(by.LEVEL.origin.scope).toBe('agent');
    expect(by.LEVEL.overrides.map((o: { scope: string }) => o.scope)).toEqual(['workspace', 'repo', 'sandbox']);
    expect(by.REPO_ONLY.origin).toMatchObject({ scope: 'repo', id: 'github.com/octocat/Hello-World' });
    expect(by.WS_ONLY.origin.scope).toBe('workspace');
    expect(by.FLAG.value).toBe('on'); // explicitly not secret
    expect(by.FILE_SECRET.value).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toContain(SECRET);
  });

  it('a new agent sees a changed variable immediately', async () => {
    await rpc('env.set', { scope: 'sandbox', id: sandboxId, vars: [{ name: 'LATE', value: 'added-later' }] });
    expect((await agentEnv(sandboxId, ['LATE'])).LATE).toBe('added-later');
    await rpc('env.unset', { scope: 'sandbox', id: sandboxId, names: ['LATE'] });
    expect((await agentEnv(sandboxId, ['LATE'])).LATE).toBe('<unset>');
  });

  it('sandbox.exec runs with the variables too', async () => {
    const res = await rpc('sandbox.exec', { sandboxId, command: ['sh', '-c', 'echo "$SB_ONLY/$REPO_ONLY"'] });
    expect(res.stdout.trim()).toBe('from-sandbox/from-repository');
  });

  describe('.env file in the repository folder', () => {
    it('is written with the variables of target file/both, readable only by the owner', async () => {
      const res = await sh(sandboxId, 'cd /workspace && stat -c "%a" .env && cat .env');
      const [mode, ...lines] = res.stdout.trim().split('\n');
      expect(mode).toBe('600');
      expect(lines[0]).toMatch(/^# cocoon-managed/);
      expect(lines.join('\n')).toContain(`FILE_SECRET=${SECRET}`);
      expect(lines.join('\n')).toContain('FLAG=on');
      expect(lines.join('\n')).not.toContain('WS_ONLY');
    });

    it('is excluded from git and never shows up in status, diffs, commits or patches', async () => {
      expect((await sh(sandboxId, 'cd /workspace && git check-ignore -v .env')).stdout).toContain('.git/info/exclude');
      expect((await sh(sandboxId, 'cat /workspace/.git/info/exclude')).stdout).toContain('/.env');
      expect((await rpc('git.status', { sandboxId })).files).toEqual([]);

      // A real change next to it: the patch only contains that change.
      await rpc('files.write', { sandboxId, path: 'notes.txt', content: 'hello\n' });
      const diff = await rpc('sandbox.diff', { sandboxId });
      expect(diff.files).toEqual(['notes.txt']);
      expect(diff.patch).not.toContain(SECRET);
      expect(diff.patch).not.toContain('FILE_SECRET');

      await rpc('git.commit', { sandboxId, message: 'notes' });
      const tracked = (await sh(sandboxId, 'cd /workspace && git ls-files && git log -p --all | grep -c "' + SECRET + '" || true')).stdout;
      expect(tracked).toContain('notes.txt');
      expect(tracked).not.toContain('.env');
      expect(tracked.trim().split('\n').at(-1)).toBe('0');
      // Even `git add -A` and a commit of "everything" leaves it out.
      await sh(sandboxId, 'cd /workspace && echo x >> notes.txt && git add -A && git commit -qm again');
      expect((await sh(sandboxId, 'cd /workspace && git show --stat --format=%s HEAD')).stdout).not.toContain('.env');
    });

    it('does not appear in the archive diff export either', async () => {
      const { patch, files } = await rpc('sandbox.diff', { sandboxId });
      expect(files).not.toContain('.env');
      expect(patch).not.toContain(SECRET);
    });

    it('is updated by "apply now" and when the next agent starts', async () => {
      await rpc('env.set', { scope: 'workspace', id: workspaceId, vars: [{ name: 'FILE_SECRET', value: `${SECRET}-v2`, target: 'file' }] });
      // Not yet: running sandboxes keep their file until applied or the next agent starts.
      expect((await sh(sandboxId, 'cat /workspace/.env')).stdout).toContain(`FILE_SECRET=${SECRET}\n`);
      const { files } = await rpc('env.apply', { sandboxId });
      expect(files).toEqual([{ folder: '', path: '.env', status: 'written', vars: expect.any(Number) }]);
      expect((await sh(sandboxId, 'cat /workspace/.env')).stdout).toContain(`FILE_SECRET=${SECRET}-v2`);

      await rpc('env.set', { scope: 'workspace', id: workspaceId, vars: [{ name: 'FILE_SECRET', value: `${SECRET}-v3`, target: 'file' }] });
      await agentEnv(sandboxId, ['LEVEL']); // starting an agent re-writes the file
      expect((await sh(sandboxId, 'cat /workspace/.env')).stdout).toContain(`FILE_SECRET=${SECRET}-v3`);
    });

    it('is removed when no variable targets a file any more, but a foreign .env is never touched', async () => {
      const mine = await createSandbox({ name: 'envfile', workspaceId: undefined });
      try {
        await rpc('env.set', { scope: 'sandbox', id: mine.id, vars: [{ name: 'A', value: '1', target: 'file' }], filePath: 'config/.env.local' });
        await rpc('env.apply', { sandboxId: mine.id });
        expect((await sh(mine.id, 'cat /workspace/config/.env.local')).stdout).toContain('A=1');
        expect((await sh(mine.id, 'cd /workspace && git status --porcelain')).stdout.trim()).toBe('');
        await rpc('env.unset', { scope: 'sandbox', id: mine.id, names: ['A'] });
        const { files } = await rpc('env.apply', { sandboxId: mine.id });
        expect(files[0].status).toBe('removed');
        expect((await sh(mine.id, 'test -e /workspace/config/.env.local && echo yes || echo no')).stdout.trim()).toBe('no');

        await sh(mine.id, 'echo HANDWRITTEN=1 > /workspace/.env');
        await rpc('env.set', { scope: 'sandbox', id: mine.id, vars: [{ name: 'B', value: SECRET, target: 'file' }], filePath: '' });
        const applied = await rpc('env.apply', { sandboxId: mine.id });
        expect(applied.files[0].status).toBe('skipped');
        expect((await sh(mine.id, 'cat /workspace/.env')).stdout.trim()).toBe('HANDWRITTEN=1');
      } finally {
        await rpc('sandbox.delete', { sandboxId: mine.id }).catch(() => undefined);
      }
    });

    it('does not write into a .env file that the repository tracks', async () => {
      const tracked = await createSandbox({ name: 'envtracked', workspaceId: undefined });
      try {
        await sh(tracked.id, 'cd /workspace && echo COMMITTED=1 > .env && git add .env && git -c user.name=t -c user.email=t@t commit -qm env');
        await rpc('env.set', { scope: 'sandbox', id: tracked.id, vars: [{ name: 'B', value: SECRET, target: 'file' }] });
        const { files } = await rpc('env.apply', { sandboxId: tracked.id });
        expect(files[0].status).toBe('skipped');
        expect((await sh(tracked.id, 'cat /workspace/.env; git -C /workspace status --porcelain')).stdout.trim()).toBe('COMMITTED=1');
      } finally {
        await rpc('sandbox.delete', { sandboxId: tracked.id }).catch(() => undefined);
      }
    });
  });

  describe('secrets stay masked', () => {
    it('are not returned by the API, the activity log or sandbox.get', async () => {
      const everything = JSON.stringify(await Promise.all([
        rpc('env.get', { scope: 'workspace', id: workspaceId }),
        rpc('env.get', { scope: 'repo', id: HELLO }),
        rpc('env.get', { scope: 'sandbox', id: sandboxId }),
        rpc('env.resolve', { sandboxId }),
        rpc('sandbox.get', { sandboxId }),
        rpc('sandbox.list'),
        rpc('workspace.get', { workspaceId }),
        rpc('agent.list', {}),
        rpc('activity.list', {}),
        rpc('settings.get'),
        rpc('secrets.list'),
      ]));
      for (const value of [SECRET, PROXY_SECRET, BASIC_SECRET]) expect(everything).not.toContain(value);
      expect(everything).toContain('FILE_SECRET'); // names are visible, values are not
    });

    it('are not part of the container configuration visible to the Docker host', async () => {
      // Variables are applied per process (agent start, exec), never through the container's own Env.
      const config = docker('inspect', `cocoon-${sandboxId}`);
      for (const value of [SECRET, PROXY_SECRET, BASIC_SECRET, 'from-sandbox', 'from-workspace']) expect(config).not.toContain(value);
    });
  });

  describe('credential proxy: API keys for a host', () => {
    it('the sandbox only has placeholders; the proxy adds the real key on the way out', async () => {
      const seen = await agentEnv(sandboxId, ['PING_KEY', 'PING_BASE_URL', 'BASIC_KEY', 'BASIC_BASE_URL']);
      expect(seen.PING_KEY).toMatch(/^cocoon_[0-9a-f]+_PING_KEY$/);
      expect(seen.BASIC_KEY).toMatch(/^cocoon_[0-9a-f]+_BASIC_KEY$/);
      expect(seen.PING_BASE_URL).toMatch(/\/t\/[0-9a-f]+\/env-sb_[0-9a-z]+-http-localhost-port-\d+$/);

      const agent = await rpc('agent.spawn', { sandboxId, kind: 'shell' });
      await rpc('agent.send_input', {
        agentId: agent.id,
        text: 'curl -s -H "Authorization: Bearer $PING_KEY" "$PING_BASE_URL/bearer"; echo; curl -s -u "$BASIC_KEY:" "$PING_BASE_URL/basic"; echo done-$?',
      });
      const screen = await waitFor('proxied calls', async () => {
        const { text } = await rpc('agent.read', { agentId: agent.id, lines: 60 });
        return /done-\d+/.test(text) && text;
      }, 60_000);
      await rpc('agent.kill', { agentId: agent.id });

      expect(screen).toContain('pong');
      expect(screen).not.toContain(PROXY_SECRET);
      expect(api.requests.find((r) => r.path === '/bearer')?.auth).toBe(`Bearer ${PROXY_SECRET}`);
      const basic = api.requests.find((r) => r.path === '/basic')?.auth ?? '';
      expect(Buffer.from(basic.replace(/^Basic /, ''), 'base64').toString()).toBe(`${BASIC_SECRET}:`);
    });

    it('the real value is nowhere in the sandbox: not in environment, processes, files or the .env file', async () => {
      const search = await sh(
        sandboxId,
        `cd /workspace && cat .env; env; cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n'; ` +
          `grep -rIl --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -e '${PROXY_SECRET}' -e '${BASIC_SECRET}' /workspace /home /opt/cocoon /tmp /etc 2>/dev/null; true`,
      );
      expect(search.stdout).not.toContain(PROXY_SECRET);
      expect(search.stdout).not.toContain(BASIC_SECRET);
      expect(search.stdout).toMatch(/PING_KEY=cocoon_[0-9a-f]+_PING_KEY/); // the placeholder is in the .env file
    });

    it('is not injected at all when the sandbox has no network', async () => {
      const offline = await createSandbox({ name: 'envoffline', network: 'none', workspaceId });
      try {
        await rpc('env.set', { scope: 'sandbox', id: offline.id, vars: [{ name: 'OFFLINE_KEY', value: PROXY_SECRET, proxyHost: 'api.example.com', target: 'both' }] });
        const resolved = await rpc('env.resolve', { sandboxId: offline.id });
        expect(resolved.vars.find((v: { name: string }) => v.name === 'OFFLINE_KEY').skipped).toBeTruthy();
        const seen = await agentEnv(offline.id, ['OFFLINE_KEY']);
        expect(seen.OFFLINE_KEY).toBe('<unset>');
        await rpc('env.apply', { sandboxId: offline.id });
        expect((await sh(offline.id, 'cat /workspace/.env 2>/dev/null; true')).stdout).not.toContain(PROXY_SECRET);
      } finally {
        await rpc('sandbox.delete', { sandboxId: offline.id }).catch(() => undefined);
      }
    });
  });

  it('deleting the sandbox drops its variables; repository and workspace variables stay', async () => {
    const temp = await createSandbox({ name: 'envtemp', workspaceId });
    await rpc('env.set', { scope: 'sandbox', id: temp.id, vars: [{ name: 'GONE', value: '1' }] });
    await rpc('sandbox.delete', { sandboxId: temp.id });
    await expect(rpc('env.get', { scope: 'sandbox', id: temp.id })).rejects.toThrow(/not found|nicht gefunden/);
    expect((await rpc('env.get', { scope: 'workspace', id: workspaceId })).vars.length).toBeGreaterThan(0);
  });
});
