import { request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { PREVIEW_COOKIE, type PortService } from './ports.ts';

/** Cookie header without the preview session cookie (the app in the sandbox must never see it). */
function stripSessionCookie(value: string | string[] | undefined): string | undefined {
  const rest = String(value ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(`${PREVIEW_COOKIE}=`));
  return rest.length ? rest.join('; ') : undefined;
}

function sessionOf(req: IncomingMessage): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === PREVIEW_COOKIE) return value.join('=');
  }
  return undefined;
}

/** Headers for the app in the sandbox: Host as the dev server expects it (dev servers often only allow localhost). */
function upstreamHeaders(req: IncomingMessage, port: number, prefix = ''): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers[key] = value;
  const cookie = stripSessionCookie(req.headers.cookie);
  if (cookie) headers.cookie = cookie;
  else delete headers.cookie;
  headers['x-forwarded-host'] = req.headers.host ?? '';
  if (prefix) headers['x-forwarded-prefix'] = prefix;
  headers['x-forwarded-proto'] = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  headers.host = `localhost:${port}`;
  return headers;
}

function page(res: ServerResponse, status: number, title: string, text: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:15vh auto;padding:0 24px;color:#111827">` +
      `<h1 style="font-size:22px">${title}</h1><p>${text}</p></body>`,
  );
}

/** Handles an HTTP request for a preview (host name p<port>-<sandbox>.<suffix> or path /preview/p<port>-<sandbox>/). */
export function servePreview(ports: PortService, req: IncomingMessage, res: ServerResponse, secure: boolean): void {
  const host = req.headers.host ?? '';
  const route = ports.previewRoute(host, req.url)!;
  const url = new URL(route.rest, 'http://preview');
  const token = url.searchParams.get('cocoon_preview');
  if (token) {
    const session = ports.redeemFor(token, route);
    if (!session) {
      const problem = ports.linkProblem(token, route);
      console.warn(`preview link rejected (${problem}): host=${host} url=${req.url?.split('?')[0]} expected suffix=${ports.previewSuffix}`);
      const hint =
        problem === 'wrong-host'
          ? `Host mismatch: the link was opened on "${host.replace(/[<>&"]/g, '')}", expected p&lt;port&gt;-&lt;sandbox&gt;.${ports.previewSuffix}. / Der Host passt nicht zum Link.`
          : problem === 'unknown-token'
            ? 'The link is unknown to the server (already used, or CoCoon was restarted). / Der Link ist dem Server unbekannt (benutzt oder CoCoon neu gestartet).'
            : 'This link is too old. / Der Link ist zu alt.';
      return page(res, 403, 'Preview link expired', `${hint}<br>Open the preview again from CoCoon. / Öffne die Vorschau erneut in CoCoon.`);
    }
    url.searchParams.delete('cocoon_preview');
    const https = secure || req.headers['x-forwarded-proto'] === 'https';
    res.writeHead(302, {
      location: route.prefix + url.pathname + url.search,
      'set-cookie': `${PREVIEW_COOKIE}=${session}; Path=${route.prefix || '/'}${route.prefix ? '/' : ''}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`,
      'cache-control': 'no-store',
    });
    return void res.end();
  }

  const target = route;
  const hostPort = ports.previewTargetFor(route, sessionOf(req));
  if (!hostPort) {
    return page(res, 401, 'Not logged in to this preview', 'Open the preview from CoCoon (Sandbox → Ports). / Öffne die Vorschau aus CoCoon heraus (Sandbox → Ports).');
  }
  const upstream = request({ host: '127.0.0.1', port: hostPort, method: req.method, path: route.rest, headers: upstreamHeaders(req, target.port, route.prefix) }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    if (res.headersSent) return void res.destroy();
    page(
      res,
      502,
      `Nothing answers on port ${target.port}`,
      `Is the server running and does it listen on 0.0.0.0 (e.g. <code>--host 0.0.0.0</code>)? / Läuft der Server und lauscht er auf 0.0.0.0?`,
    );
  });
  req.pipe(upstream);
}

/** Handles a WebSocket (or other) upgrade for a preview host by piping raw TCP to the gateway. */
export function upgradePreview(ports: PortService, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const target = ports.previewRoute(req.headers.host, req.url);
  const hostPort = target && ports.previewTargetFor(target, sessionOf(req));
  if (!target || !hostPort) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  const upstream = connect(hostPort, '127.0.0.1', () => {
    const headers = upstreamHeaders(req, target.port, target.prefix);
    let raw = `${req.method} ${target.rest} HTTP/${req.httpVersion}\r\n`;
    for (const [key, value] of Object.entries(headers)) for (const v of Array.isArray(value) ? value : [value]) raw += `${key}: ${v}\r\n`;
    upstream.write(`${raw}\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', close);
  socket.on('error', close);
}

/** Routes upgrades of preview hosts to the preview proxy and everything else to the existing listeners (Fastify websockets). */
export function routePreviewUpgrades(server: Server, ports: PortService): void {
  const existing = server.listeners('upgrade') as ((req: IncomingMessage, socket: Duplex, head: Buffer) => void)[];
  server.removeAllListeners('upgrade');
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (ports.previewRoute(req.headers.host, req.url)) return upgradePreview(ports, req, socket, head);
    for (const listener of existing) listener.call(server, req, socket, head);
  });
}
