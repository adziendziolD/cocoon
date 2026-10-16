import { AGENT_TOOLS, AgentTool } from '../../packages/protocol/src/index.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { available, createSandbox, rpc, sh, waitFor } from './harness.ts';

/** The slim image has no Node.js: agent CLIs must run with the toolbox's own (installed by the global setup). */
describe.runIf(available)('slim image + agent toolbox', () => {
  let id: string;

  beforeAll(async () => {
    id = (await createSandbox({ name: 'toolbox' })).id;
  });
  afterAll(async () => {
    if (id) await rpc('sandbox.delete', { sandboxId: id }).catch(() => undefined);
  });

  it('builds a slim image under 250 MB without Node.js, and a toolbox with Node.js', async () => {
    const images = await rpc('image.status');
    const sandbox = images.find((i: { kind: string }) => i.kind === 'sandbox');
    console.log(`[integration] ${sandbox.ref}: ${sandbox.sizeMb} MB (${sandbox.variant})`);
    expect(sandbox.variant).toBe('slim');
    expect(sandbox.sizeMb).toBeLessThan(250);
    const toolbox = images.find((i: { kind: string }) => i.kind === 'agents');
    expect(toolbox.runtime).toMatch(/^\d+\.\d+\.\d+/);
    expect(toolbox.tools.sort()).toEqual([...AgentTool.options].sort());
  });

  it('finds Node.js and npm in the toolbox, also in login shells', async () => {
    const res = await sh(id, 'command -v node; node --version; npm --version; ls /usr/local/bin /usr/bin | grep -cx node || true');
    expect(res.exitCode).toBe(0);
    const [nodePath, nodeVersion, npmVersion, imageNodes] = res.stdout.trim().split('\n');
    expect(nodePath).toBe('/opt/agents/bin/node');
    expect(nodeVersion).toMatch(/^v\d+\./);
    expect(npmVersion).toMatch(/^\d+\./);
    expect(imageNodes).toBe('0');
  });

  it.each(AgentTool.options)('%s runs from the toolbox', async (tool) => {
    const { bin } = AGENT_TOOLS[tool];
    const res = await sh(id, `command -v ${bin} && timeout 60 ${bin} --version </dev/null 2>&1`);
    expect(res.exitCode, `${bin} --version:\n${res.stdout}${res.stderr}`).toBe(0);
    expect(res.stdout).toContain(`/opt/agents/bin/${bin}`);
    expect(res.stdout).toMatch(/\d+\.\d+/);
  });

  it.each(['claude-code', 'codex', 'opencode', 'pi', 'qwen-code', 'gemini', 'shell'])('agent type %s starts', async (kind) => {
    const agent = await rpc('agent.spawn', { sandboxId: id, kind });
    try {
      // Without credentials the CLIs show their login screen – but they must start (no "node: not found" or libc errors).
      const screen = await waitFor(`${kind} output`, async () => (await rpc('agent.read', { agentId: agent.id, lines: 80 })).text.trim(), 60_000);
      await new Promise((r) => setTimeout(r, 5000));
      const after = await rpc('agent.get', { agentId: agent.id });
      const text = (await rpc('agent.read', { agentId: agent.id, lines: 80 })).text || screen;
      expect(text).not.toMatch(/node: not found|: No such file or directory|error while loading shared libraries|GLIBC_\d|Error relocating/);
      if (after.status === 'exited') expect(after.exitCode, `${kind} exited:\n${text}`).toBe(0);
    } finally {
      await rpc('agent.kill', { agentId: agent.id }).catch(() => undefined);
    }
  });
});
