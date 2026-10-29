import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { methods } from '@cocoon/protocol';
import type { Rpc } from './rpc.ts';
import { VERSION } from './version.ts';

/** MCP tool name ↔ API method, e.g. "sandbox_create" ↔ "sandbox.create". */
const tools = Object.entries(methods)
  .filter(([, def]) => 'mcp' in def && def.mcp)
  .map(([method, def]) => ({
    method,
    name: method.replace('.', '_'),
    description: def.description,
    inputSchema: { type: 'object' as const, ...(z.toJSONSchema(def.params, { io: 'input', unrepresentable: 'any' }) as object) },
  }));

function buildServer(rpc: Rpc): Server {
  const server = new Server(
    { name: 'cocoon', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'CoCoon runs coding agents in isolated sandboxes. Typical flow: sandbox_create → agent_spawn (kind "claude-code", "codex" or "shell", with a prompt) → agent_wait → agent_read / agent_send_input while blocked → sandbox_diff or git_push + git_create_pr → sandbox_delete.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown tool ${request.params.name}` }] };
    try {
      const result = await rpc(tool.method, request.params.arguments ?? {}, extra.signal);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
    }
  });
  return server;
}

/** Stateless Streamable-HTTP MCP endpoint: a fresh server/transport per request. */
export async function handleMcp(rpc: Rpc, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const server = buildServer(rpc);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
