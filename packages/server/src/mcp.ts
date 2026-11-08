import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { methods, type MethodName } from '@cocoon/protocol';
import { mayCall } from './auth/access.ts';
import type { Principal } from './auth/principal.ts';
import type { Rpc } from './rpc.ts';
import { VERSION } from './version.ts';

/** MCP tool name ↔ API method, e.g. "sandbox_create" ↔ "sandbox.create". */
const tools = (Object.entries(methods) as Array<[MethodName, (typeof methods)[MethodName]]>)
  .filter(([, def]) => 'mcp' in def && def.mcp)
  .map(([method, def]) => ({
    method,
    name: method.replace('.', '_'),
    description: def.description,
    inputSchema: { type: 'object' as const, ...(z.toJSONSchema(def.params, { io: 'input', unrepresentable: 'any' }) as object) },
  }));

function buildServer(rpc: Rpc, caller: Principal): Server {
  // The list only shows what the caller may use; rpc() checks again on every call.
  const allowed = tools.filter((tool) => mayCall(caller.role, tool.method));
  const server = new Server(
    { name: 'cocoon', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'CoCoon runs coding agents in isolated sandboxes. Typical flow: sandbox_create → agent_spawn (kind "claude-code", "codex" or "shell", with a prompt) → agent_wait → agent_read / agent_send_input while blocked → sandbox_diff or git_push + git_create_pr → sandbox_delete.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allowed.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = allowed.find((t) => t.name === request.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown tool ${request.params.name}` }] };
    try {
      const result = await rpc(caller, tool.method, request.params.arguments ?? {}, extra.signal);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
    }
  });
  return server;
}

/** Stateless Streamable-HTTP MCP endpoint: a fresh server/transport per request. */
export async function handleMcp(rpc: Rpc, caller: Principal, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const server = buildServer(rpc, caller);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
