import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { available, createSandbox, rpc, sh, waitFor } from './harness.ts';

const REAL_KEY = `real-secret-${Math.random().toString(16).slice(2)}`;

/** Fake chat-only model server on the host: records requests, answers /v1/chat/completions, 404 for everything else. */
function fakeModelServer() {
  const requests: { path: string; auth?: string; body: any }[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ path: req.url ?? '', auth: req.headers.authorization, body });
    if (req.url === '/v1/models') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fake-1', context_length: 32768 }] }));
    if (req.url === '/v1/chat/completions') {
      const last = body.messages.at(-1);
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: `echo: ${typeof last.content === 'string' ? last.content : JSON.stringify(last.content)}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        }),
      );
    }
    if (req.url === '/api/ping') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('pong');
    res.writeHead(404).end();
  });
  return { server, requests };
}

describe.runIf(available)('credential proxy and API translation', () => {
  let fake: { server: Server; requests: { path: string; auth?: string; body: any }[] };
  let port: number;
  let sandboxId: string;

  beforeAll(async () => {
    fake = fakeModelServer();
    // 0.0.0.0: the proxy container reaches the host through the Docker host gateway.
    await new Promise<void>((resolve) => fake.server.listen(0, '0.0.0.0', resolve));
    port = (fake.server.address() as AddressInfo).port;

    await rpc('secrets.set', { name: 'FAKE_API_KEY', value: REAL_KEY });
    await rpc('secrets.set', { name: 'PING_API_KEY', value: REAL_KEY });
    const settings = await rpc('settings.get');
    await rpc('settings.update', {
      providers: {
        ...settings.providers,
        fake: { label: 'Fake LLM', kind: 'openai', baseUrl: `http://localhost:${port}/v1`, secret: 'FAKE_API_KEY', auth: 'bearer', models: ['fake-1'], defaultModel: 'fake-1' },
        ping: { label: 'Ping API', kind: 'http', baseUrl: `http://localhost:${port}/api`, secret: 'PING_API_KEY', auth: 'bearer' },
      },
      // An agent type wired like Claude Code (env, --model …) that is just a shell: the extra arguments become
      // positional parameters of `bash -c` and are ignored.
      agents: { ...settings.agents, 'messages-probe': { command: ['bash', '-c', 'exec bash', 'probe'], adapter: 'claude-code', providers: ['fake'] } },
    });
    const test = await rpc('providers.test', { id: 'fake' });
    expect(test.ok).toBe(true);
    sandboxId = (await createSandbox({ name: 'proxy' })).id;
  });
  afterAll(async () => {
    if (sandboxId) await rpc('sandbox.delete', { sandboxId }).catch(() => undefined);
    fake?.server.close();
  });

  it('detects that the fake server only speaks Chat Completions, and its context window', async () => {
    const test = await rpc('providers.test', { id: 'fake' });
    expect(test.apis).toEqual(['chat']);
    expect(test.modelInfo['fake-1']?.contextWindow).toBe(32768);
  });

  it('HTTP API: the agent only sees a placeholder, the proxy adds the real key', async () => {
    const agent = await rpc('agent.spawn', { sandboxId, kind: 'shell', providers: ['ping'] });
    await rpc('agent.send_input', { agentId: agent.id, text: 'echo "key=$PING_API_KEY"; curl -s -H "Authorization: Bearer $PING_API_KEY" "$PING_BASE_URL/ping"; echo' });
    const screen = await waitFor('ping answer', async () => {
      const { text } = await rpc('agent.read', { agentId: agent.id, lines: 40 });
      return /pong/.test(text) && text;
    }, 60_000);
    expect(screen).toMatch(/key=cocoon_[0-9a-f]+_PING_API_KEY/);
    expect(screen).not.toContain(REAL_KEY);
    expect(fake.requests.find((r) => r.path === '/api/ping')?.auth).toBe(`Bearer ${REAL_KEY}`);
    await rpc('agent.kill', { agentId: agent.id });
  });

  it('translates Anthropic Messages to Chat Completions for a chat-only server', async () => {
    const agent = await rpc('agent.spawn', { sandboxId, kind: 'messages-probe' });
    expect(agent.model).toBe('fake-1');
    expect(agent.contextWindow).toBe(32768);
    await rpc('agent.send_input', {
      agentId: agent.id,
      text: `curl -s "$ANTHROPIC_BASE_URL/v1/messages" -H "x-api-key: \${ANTHROPIC_API_KEY:-$ANTHROPIC_AUTH_TOKEN}" -H "authorization: Bearer \${ANTHROPIC_AUTH_TOKEN:-$ANTHROPIC_API_KEY}" -H "content-type: application/json" -d '{"model":"fake-1","max_tokens":100000,"system":"be brief","messages":[{"role":"user","content":"hallo"}]}' > /tmp/answer.json; echo done-$?`,
    });
    const screen = await waitFor('translated answer', async () => {
      const { text } = await rpc('agent.read', { agentId: agent.id, lines: 30 });
      return /done-\d+/.test(text) && text;
    }, 60_000);
    const raw = (await sh(sandboxId, 'cat /tmp/answer.json')).stdout;
    expect(screen, `screen:\n${screen}\nanswer:\n${raw}`).toContain('done-0');
    const answer = JSON.parse(raw);
    expect(answer.type).toBe('message');
    expect(answer.role).toBe('assistant');
    expect(answer.content[0]).toEqual({ type: 'text', text: 'echo: hallo' });
    expect(answer.stop_reason).toBe('end_turn');
    expect(answer.usage).toMatchObject({ input_tokens: 7, output_tokens: 3 });

    const upstream = fake.requests.filter((r) => r.path === '/v1/chat/completions').at(-1)!;
    expect(upstream.auth).toBe(`Bearer ${REAL_KEY}`);
    expect(upstream.body.messages[0]).toEqual({ role: 'system', content: 'be brief' });
    // The proxy caps the answer length at the model's limit (a quarter of the 32k context window).
    expect(upstream.body.max_tokens).toBe(8192);
    await rpc('agent.kill', { agentId: agent.id });
  });
});
