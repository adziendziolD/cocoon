import { existsSync } from 'node:fs';
import Fastify, { type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { AttachControl, EventFilter, LoginParams, matchesFilter, SetupInfoParams, SetupParams, WireRequest, type WireError, type WireResponse } from '@cocoon/protocol';
import { localizeEntry } from './activity.ts';
import { localizeTask } from './tasks.ts';
import type { AgentManager } from './agents/manager.ts';
import { eventFor } from './auth/access.ts';
import type { Principal } from './auth/principal.ts';
import type { AuthService } from './auth/users.ts';
import type { Config } from './config.ts';
import { CocoonError, httpStatus } from './errors.ts';
import type { EventBus } from './events.ts';
import { resolveLanguage, t, withLanguage } from './i18n.ts';
import { handleMcp } from './mcp.ts';
import type { PortService } from './ports.ts';
import { routePreviewUpgrades, servePreview } from './preview.ts';
import type { Rpc } from './rpc.ts';
import type { WorkspaceService } from './sandbox/workspace.ts';

export interface HttpDeps {
  config: Config;
  rpc: Rpc;
  bus: EventBus;
  auth: AuthService;
  agents: AgentManager;
  workspace: WorkspaceService;
  ports: PortService;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Who the request comes from; set by the authentication hook on every route that is not public. */
    principal: Principal | null;
  }
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

/** Sign-in and choosing a password: the only POST routes that need no token. */
const PUBLIC_POST_ROUTES = new Set(['/v1/auth/login', '/v1/auth/setup-info', '/v1/auth/setup']);

/**
 * Routes that need no token: the health check, the sign-in routes and the static web UI (including its not-found fallback).
 * Everything else is authenticated, so a route added later is protected by default.
 * Decided by the route Fastify matched, not by the raw URL: Fastify routes on the decoded path, so a check on
 * the raw string is bypassed by percent-encoding (`/%761/rpc/...` reaches `/v1/rpc/...`).
 */
export function isPublicRoute(method: string, routeUrl: string | undefined): boolean {
  if (routeUrl === '/healthz') return method === 'GET' || method === 'HEAD';
  if (method === 'POST') return routeUrl !== undefined && PUBLIC_POST_ROUTES.has(routeUrl);
  if (method !== 'GET' && method !== 'HEAD') return false;
  return routeUrl === undefined || routeUrl === '/' || routeUrl === '/*';
}

/** Replaces the value of a `token` query parameter, so credentials do not end up in logs. */
export const redactToken = (url: string | undefined) => url?.replace(/([?&]token=)[^&#]*/gi, '$1[redacted]');

/** WebSocket frames are RPC calls and terminal input, never bulk data (the ws default is 100 MB). */
export const WS_MAX_PAYLOAD = 8 * 1024 * 1024;

/** Closes sockets of a session that ended or a token that was revoked (application close code). */
const SIGNED_OUT = 4401;

export async function buildHttpServer({ config, rpc, bus, auth, agents, workspace, ports }: HttpDeps) {
  const app = Fastify({
    // Only with COCOON_TRUST_PROXY: otherwise a client could forge X-Forwarded-For and escape the sign-in throttle.
    trustProxy: config.trustProxy,
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: {
        req: (req) => ({ method: req.method, url: redactToken(req.url), host: req.host, remoteAddress: req.ip, remotePort: req.socket?.remotePort }),
      },
    },
    bodyLimit: 64 * 1024 * 1024,
  });
  await app.register(websocket, { options: { maxPayload: WS_MAX_PAYLOAD } });
  routePreviewUpgrades(app.server, ports);

  // Previews of sandbox servers (p<port>-<sandbox>.<domain>) have their own login (one-time link → cookie for that host).
  app.addHook('onRequest', async (req, reply) => {
    if (!ports.previewRoute(req.headers.host, req.url)) return;
    reply.hijack();
    servePreview(ports, req.raw, reply.raw, Boolean(config.ports.previewDomain));
  });

  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (req, reply) => {
    if (isPublicRoute(req.method, req.routeOptions.url)) return;
    const header = req.headers.authorization;
    // Browsers cannot set headers on WebSocket upgrades or downloads, so accept ?token= as a fallback.
    const provided = header?.startsWith('Bearer ') ? header.slice(7) : (req.query as { token?: string })?.token;
    const principal = auth.authenticate(provided);
    if (!principal) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: t('error.unauthorized', {}, requestLanguage(req)) } });
    }
    req.principal = principal;
  });

  /** The authenticated caller. Every route that is not public has one; a request without it is refused. */
  const callerOf = (req: FastifyRequest): Principal => {
    if (!req.principal) throw new CocoonError('unauthorized', t('error.unauthorized', {}, requestLanguage(req)));
    return req.principal;
  };

  // Open sockets by credential: when a session ends (sign-out, expiry, lock) or a token is revoked, its sockets are closed.
  const sockets = new Map<string, Set<WebSocket>>();
  auth.onRevoked((credentialId) => {
    for (const socket of sockets.get(credentialId) ?? []) socket.close(SIGNED_OUT, 'signed out');
  });
  /** Registers a socket for the closing above. False if the credential stopped working in the meantime (the socket is closed). */
  const track = (caller: Principal, socket: WebSocket): boolean => {
    const open = sockets.get(caller.credentialId) ?? new Set<WebSocket>();
    open.add(socket);
    sockets.set(caller.credentialId, open);
    socket.on('close', () => {
      open.delete(socket);
      if (!open.size && sockets.get(caller.credentialId) === open) sockets.delete(caller.credentialId);
    });
    if (auth.touch(caller)) return true;
    socket.close(SIGNED_OUT, 'signed out');
    return false;
  };

  app.get('/healthz', async () => ({ ok: true }));

  /** Sign-in and choosing a password need no token. Anyone can send these, so the bodies are small. */
  const publicPost = <S extends z.ZodType>(path: string, schema: S, run: (input: z.output<S>, req: FastifyRequest) => Promise<unknown> | unknown) =>
    app.post(path, { bodyLimit: 4 * 1024 }, async (req, reply) => {
      const lang = requestLanguage(req);
      try {
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) throw new CocoonError('bad_request', t('error.invalidParams', { details: z.prettifyError(parsed.error) }, lang));
        const result = await withLanguage(lang, () => run(parsed.data, req));
        return reply.header('cache-control', 'no-store').send({ result });
      } catch (err) {
        const error = toWireError(err);
        if (error.code === 'internal') req.log.error(err);
        const retry = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
        if (retry) reply.header('retry-after', String(retry));
        return reply.code(httpStatus[error.code]).header('cache-control', 'no-store').send({ error });
      }
    });
  publicPost('/v1/auth/login', LoginParams, (input, req) => auth.login(input.username, input.password, req.ip));
  publicPost('/v1/auth/setup-info', SetupInfoParams, (input, req) => auth.setupInfo(input.token, req.ip));
  publicPost('/v1/auth/setup', SetupParams, (input, req) => auth.completeSetup(input.token, input.password, req.ip));

  /** Request/response API: POST /v1/rpc/sandbox.create  {params} */
  app.post<{ Params: { method: string } }>('/v1/rpc/:method', async (req, reply) => {
    try {
      // A client that hangs up (e.g. during a long agent.wait) aborts the call.
      const caller = callerOf(req);
      const gone = new AbortController();
      reply.raw.once('close', () => gone.abort());
      return { result: await withLanguage(requestLanguage(req), () => rpc(caller, req.params.method, req.body ?? {}, gone.signal)) };
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
    const caller = callerOf(req);
    reply.hijack();
    await withLanguage(requestLanguage(req), () => handleMcp(rpc, caller, req.raw, reply.raw, req.body));
  });
  app.get('/mcp', async (_req, reply) => reply.code(405).header('allow', 'POST').send());

  /** Multiplexed control socket: RPC calls + event subscriptions. */
  app.get('/v1/ws', { websocket: true }, (socket: WebSocket, req) => {
    const caller = callerOf(req);
    if (!track(caller, socket)) return;
    const subscriptions = new Map<string, () => void>();
    const gone = new AbortController();
    const lang = requestLanguage(req);
    const send = (msg: WireResponse | { subscription: string; event: unknown }) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    socket.on('message', async (data) => {
      // Messages count as activity; a session that ended meanwhile is cut off here too.
      if (!auth.touch(caller)) return void socket.close(SIGNED_OUT, 'signed out');
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
            bus.subscribe((event) => {
              const visible = matchesFilter(event, filter) ? eventFor(event, caller) : undefined;
              if (!visible) return;
              send({
                subscription,
                event:
                  visible.type === 'activity' ? { ...visible, entry: localizeEntry(visible.entry, lang) }
                  : visible.type === 'task.updated' ? { ...visible, task: localizeTask(visible.task, lang) }
                  : visible,
              });
            }),
          );
          return send({ id, result: { subscription } });
        }
        if (method === 'events.unsubscribe') {
          const subscription = String((params as { subscription?: string })?.subscription);
          subscriptions.get(subscription)?.();
          subscriptions.delete(subscription);
          return send({ id, result: { ok: true } });
        }
        send({ id, result: await withLanguage(lang, () => rpc(caller, method, params, gone.signal)) });
      } catch (err) {
        const error = toWireError(err);
        if (error.code === 'internal') req.log.error(err);
        send({ id, error });
      }
    });
    socket.on('close', () => {
      gone.abort();
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
      const caller = callerOf(req);
      if (!track(caller, socket)) return;
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
        // Typing counts as activity, so someone working in a terminal is not signed out for being idle.
        if (!auth.touch(caller)) return void socket.close(SIGNED_OUT, 'signed out');
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
      req.url.startsWith('/v1/') || req.url === '/mcp' || req.url.startsWith('/mcp?') || req.method !== 'GET' || req.url.startsWith('/assets/')
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
