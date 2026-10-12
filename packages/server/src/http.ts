import { existsSync } from 'node:fs';
import Fastify, { type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { AttachControl, EventFilter, matchesFilter, WireRequest, type WireError, type WireResponse } from '@cocoon/protocol';
import { localizeEntry } from './activity.ts';
import { localizeTask } from './tasks.ts';
import type { AgentManager } from './agents/manager.ts';
import type { Config } from './config.ts';
import { CocoonError, httpStatus } from './errors.ts';
import type { EventBus } from './events.ts';
import { resolveLanguage, t, withLanguage } from './i18n.ts';
import { handleMcp } from './mcp.ts';
import type { Rpc } from './rpc.ts';
import type { WorkspaceService } from './sandbox/workspace.ts';
import type { TokenService } from './tokens.ts';

export interface HttpDeps {
  config: Config;
  rpc: Rpc;
  bus: EventBus;
  tokens: TokenService;
  agents: AgentManager;
  workspace: WorkspaceService;
}

export function toWireError(err: unknown): WireError {
  if (err instanceof CocoonError) return { code: err.code, message: err.message, details: err.details };
  return { code: 'internal', message: (err as Error)?.message ?? String(err) };
}

/** Client language: x-cocoon-lang header or ?lang=, then Accept-Language, then the server default. */
const requestLanguage = (req: FastifyRequest) =>
  resolveLanguage(
    (req.headers['x-cocoon-lang'] as string | undefined) ?? (req.query as { lang?: string })?.lang,
    req.headers['accept-language'],
  );

const isApi = (url: string) => url.startsWith('/v1/') || url === '/mcp' || url.startsWith('/mcp?');

export async function buildHttpServer({ config, rpc, bus, tokens, agents, workspace }: HttpDeps) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 64 * 1024 * 1024 });
  await app.register(websocket);

  app.addHook('onRequest', async (req, reply) => {
    if (!isApi(req.url)) return;
    const header = req.headers.authorization;
    // Browsers cannot set headers on WebSocket upgrades or downloads, so accept ?token= as a fallback.
    const provided = header?.startsWith('Bearer ') ? header.slice(7) : (req.query as { token?: string })?.token;
    if (!tokens.verify(provided)) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: t('error.unauthorized', {}, requestLanguage(req)) } });
    }
  });

  app.get('/healthz', async () => ({ ok: true }));

  /** Request/response API: POST /v1/rpc/sandbox.create  {params} */
  app.post<{ Params: { method: string } }>('/v1/rpc/:method', async (req, reply) => {
    try {
      return { result: await withLanguage(requestLanguage(req), () => rpc(req.params.method, req.body ?? {})) };
    } catch (err) {
      const error = toWireError(err);
      if (error.code === 'internal') req.log.error(err);
      return reply.code(httpStatus[error.code]).send({ error });
    }
  });

  /** Tar download of a file or directory from a sandbox. */
  app.get<{ Params: { sandboxId: string }; Querystring: { path?: string } }>('/v1/sandboxes/:sandboxId/archive', async (req, reply) => {
    try {
      const path = req.query.path ?? '.';
      const stream = await withLanguage(requestLanguage(req), () => workspace.archive(req.params.sandboxId, path));
      const name = (path.split('/').filter(Boolean).pop() ?? 'workspace').replace(/[^\w.-]/g, '_') || 'workspace';
      return reply
        .header('content-type', 'application/x-tar')
        .header('content-disposition', `attachment; filename="${name}.tar"`)
        .send(stream);
    } catch (err) {
      const error = toWireError(err);
      return reply.code(httpStatus[error.code]).send({ error });
    }
  });

  /** MCP endpoint (Streamable HTTP, stateless) – connect Claude Code or other MCP clients. */
  app.post('/mcp', async (req, reply) => {
    reply.hijack();
    await withLanguage(requestLanguage(req), () => handleMcp(rpc, req.raw, reply.raw, req.body));
  });
  app.get('/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send());

  /** Multiplexed control socket: RPC calls + event subscriptions. */
  app.get('/v1/ws', { websocket: true }, (socket: WebSocket, req) => {
    const subscriptions = new Map<string, () => void>();
    const lang = requestLanguage(req);
    const send = (msg: WireResponse | { subscription: string; event: unknown }) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    socket.on('message', async (data) => {
      let request: WireRequest;
      try {
        request = WireRequest.parse(JSON.parse(data.toString()));
      } catch {
        return send({ id: null, error: { code: 'bad_request', message: 'malformed request' } });
      }
      const { id, method, params } = request;
      try {
        if (method === 'events.subscribe') {
          const filter = EventFilter.parse(params ?? {});
          const subscription = String(id);
          subscriptions.get(subscription)?.();
          subscriptions.set(
            subscription,
            bus.subscribe(
              (event) =>
                matchesFilter(event, filter) &&
                send({
                  subscription,
                  event:
                    event.type === 'activity' ? { ...event, entry: localizeEntry(event.entry, lang) }
                    : event.type === 'task.updated' ? { ...event, task: localizeTask(event.task, lang) }
                    : event,
                }),
            ),
          );
          return send({ id, result: { subscription } });
        }
        if (method === 'events.unsubscribe') {
          const subscription = String((params as { subscription?: string })?.subscription);
          subscriptions.get(subscription)?.();
          subscriptions.delete(subscription);
          return send({ id, result: { ok: true } });
        }
        send({ id, result: await withLanguage(lang, () => rpc(method, params)) });
      } catch (err) {
        const error = toWireError(err);
        if (error.code === 'internal') req.log.error(err);
        send({ id, error });
      }
    });
    socket.on('close', () => {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
    });
  });

  /**
   * Raw interactive terminal for one agent (like `herdr attach` / `tmux attach`).
   * Binary frames carry terminal bytes; text frames carry JSON control messages (resize).
   */
  app.get<{ Params: { agentId: string }; Querystring: { cols?: string; rows?: string } }>(
    '/v1/agents/:agentId/attach',
    { websocket: true },
    async (socket: WebSocket, req) => {
      const size = { cols: Number(req.query.cols ?? 120), rows: Number(req.query.rows ?? 40) };
      let session;
      try {
        session = await withLanguage(requestLanguage(req), () => agents.attach(req.params.agentId, size));
      } catch (err) {
        socket.close(4000, toWireError(err).message.slice(0, 120));
        return;
      }
      session.stream.on('data', (chunk: Buffer) => socket.readyState === socket.OPEN && socket.send(chunk));
      session.stream.on('end', () => socket.close(1000, 'detached'));
      session.stream.on('error', () => socket.close(1011, 'stream error'));
      socket.on('message', (data, isBinary) => {
        if (isBinary) return void session.stream.write(data as Buffer);
        const control = AttachControl.safeParse(safeJson(data.toString()));
        if (control.success) void session.resize(control.data.cols, control.data.rows);
        else session.stream.write(data as Buffer);
      });
      socket.on('close', () => session.close());
    },
  );

  // Management UI (single-page app).
  if (existsSync(config.webDir)) {
    // wildcard (default) serves files dynamically, so a rebuilt UI works without restarting the server.
    await app.register(fastifyStatic, { root: config.webDir });
    app.setNotFoundHandler((req, reply) =>
      isApi(req.url) || req.method !== 'GET' || req.url.startsWith('/assets/')
        ? reply.code(404).send({ error: { code: 'not_found', message: 'not found' } })
        : reply.sendFile('index.html'),
    );
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html')
        .send('<h1>CoCoon</h1><p>The web UI has not been built yet – run <code>pnpm build:web</code>. / Die Weboberfläche ist noch nicht gebaut – <code>pnpm build:web</code> ausführen.</p>'),
    );
  }

  return app;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
