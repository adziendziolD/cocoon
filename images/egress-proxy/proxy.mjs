// CoCoon egress proxy – dependency-free.
//
// Runs as a container (Docker/Podman) or as a plain process next to cocoond (bubblewrap driver).
//
// FORWARD_PORT (3128)     HTTP(S) forward proxy (CONNECT + plain HTTP). Only allowlisted domains on ports 80/443,
//                         only for known sandboxes. Denied attempts are recorded in <POLICY_DIR>/denied.json.
// CREDENTIAL_PORT (8080)  Credential proxy. Sandboxes get placeholder keys ("cocoon_<sandboxToken>_<SECRET>") and
//                         talk to http://<proxy>/t/<token>/<route>/...; the proxy swaps placeholders for real keys
//                         (or injects the provider's auth header) and forwards upstream. Real keys never enter a sandbox.
//
// Sandboxes are identified by their token (Proxy-Authorization: Basic cocoon:<token>, or the /t/<token>/ path prefix)
// or, for container sandboxes on the internal network, by their IP.
//
// Policy (<POLICY_DIR>/policy.json, written by cocoond, reloaded on change):
//   { version, allowlist: string[], sandboxes: { [ip]: Sandbox }, tokens: { [token]: Sandbox },
//     routes: { [name]: { upstream, secrets: { [NAME]: value }, inject?: { header, value } } } }
//   Sandbox = { sandboxId, token, routes: string[] } – a sandbox may only use the credential routes it was granted.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { swapHeaders } from './placeholders.mjs';
import {
  chatToMessage,
  chatToResponse,
  countTokens,
  messagesToChat,
  responsesToChat,
  streamChatAsMessages,
  streamChatAsResponses,
} from './translate.mjs';

const POLICY_DIR = process.env.POLICY_DIR ?? '/policy';
const POLICY_FILE = `${POLICY_DIR}/policy.json`;
const ACK_FILE = `${POLICY_DIR}/ack`;
const DENIED_FILE = `${POLICY_DIR}/denied.json`;
const FORWARD_PORT = Number(process.env.FORWARD_PORT ?? 3128);
const CREDENTIAL_PORT = Number(process.env.CREDENTIAL_PORT ?? 8080);
const BIND_HOST = process.env.BIND_HOST ?? '0.0.0.0';
const ALLOWED_PORTS = new Set([80, 443]);

const log = (obj) => console.log(JSON.stringify({ at: new Date().toISOString(), ...obj }));

let policy = { allowlist: [], sandboxes: {}, tokens: {}, routes: {} };
let policyRaw = '';

// Reload when the content changes, then acknowledge the version so cocoond can wait for it.
function loadPolicy() {
  try {
    const raw = fs.readFileSync(POLICY_FILE, 'utf8');
    if (raw === policyRaw) return;
    policy = JSON.parse(raw);
    policyRaw = raw;
    fs.writeFileSync(ACK_FILE, String(policy.version ?? 0));
    log({ msg: 'policy loaded', version: policy.version, sandboxes: Object.keys(policy.sandboxes).length });
    syncRelays();
  } catch (err) {
    if (err.code !== 'ENOENT') log({ msg: 'policy load failed', error: err.message });
  }
}
// TCP relays: sandboxes on the internal network reach external servers of shared services (e.g. a database on the
// CoCoon host). Bound to the proxy's internal-network address only.
const relays = new Map(); // listen port -> { server, target, bind }
function syncRelays() {
  const wanted = new Map((policy.relays ?? []).map((r) => [r.listen, r]));
  for (const [listen, relay] of relays) {
    if (!wanted.has(listen) || relay.bind !== policy.relayBind) {
      relay.server.close();
      relays.delete(listen);
    }
  }
  if (!policy.relayBind) return;
  for (const [listen, target] of wanted) {
    const existing = relays.get(listen);
    if (existing) {
      existing.target = target;
      continue;
    }
    const relay = { target, bind: policy.relayBind };
    relay.server = net.createServer((client) => {
      const upstream = net.connect(relay.target.port, relay.target.host);
      client.pipe(upstream).pipe(client);
      const close = () => (client.destroy(), upstream.destroy());
      client.on('error', close);
      upstream.on('error', (err) => (log({ msg: 'relay upstream failed', listen, error: err.message }), close()));
    });
    relay.server.on('error', (err) => log({ msg: 'relay listen failed', listen, error: err.message }));
    relay.server.listen(listen, policy.relayBind, () => log({ msg: 'relay listening', listen, host: target.host, port: target.port }));
    relays.set(listen, relay);
  }
}
loadPolicy();
setInterval(loadPolicy, 200);

const clientIp = (socket) => (socket.remoteAddress ?? '').replace(/^::ffff:/, '');

/** Sandbox of a forward-proxy request: Proxy-Authorization token first, then source IP. */
function sandboxFor(req) {
  const auth = req.headers?.['proxy-authorization'];
  if (typeof auth === 'string' && auth.startsWith('Basic ')) {
    const [, token] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
    if (token && policy.tokens?.[token]) return policy.tokens[token];
  }
  return policy.sandboxes[clientIp(req.socket ?? req)];
}

function isAllowed(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return policy.allowlist.some((pattern) => {
    const p = pattern.toLowerCase().trim();
    return p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p;
  });
}

// ── denied log ────────────────────────────────────────────────────────────────
const denied = [];
let deniedDirty = false;
function recordDenied(req, host, port) {
  const sandbox = sandboxFor(req);
  log({ msg: 'denied', ip: clientIp(req.socket), sandboxId: sandbox?.sandboxId, host, port });
  denied.unshift({ at: new Date().toISOString(), sandboxId: sandbox?.sandboxId, host, port });
  denied.length = Math.min(denied.length, 200);
  deniedDirty = true;
}
setInterval(() => {
  if (!deniedDirty) return;
  deniedDirty = false;
  try {
    fs.writeFileSync(`${DENIED_FILE}.tmp`, JSON.stringify(denied));
    fs.renameSync(`${DENIED_FILE}.tmp`, DENIED_FILE);
  } catch (err) {
    log({ msg: 'cannot write denied log', error: err.message });
  }
}, 2000);

// ── forward proxy :3128 ───────────────────────────────────────────────────────
const forward = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url);
  } catch {
    res.writeHead(400).end('CoCoon egress proxy: absolute URL required\n');
    return;
  }
  const port = Number(url.port || 80);
  if (url.protocol !== 'http:' || !sandboxFor(req) || !ALLOWED_PORTS.has(port) || !isAllowed(url.hostname)) {
    recordDenied(req, url.hostname, port);
    res.writeHead(403).end(`cocoon: access to ${url.hostname} is not allowed (add it to the allowlist)\n`);
    return;
  }
  const headers = { ...req.headers };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  const upstream = http.request(
    { host: url.hostname, port, path: url.pathname + url.search, method: req.method, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on('error', () => res.headersSent ? res.destroy() : res.writeHead(502).end());
  req.pipe(upstream);
});

forward.on('connect', (req, clientSocket, head) => {
  const [host, portText] = (req.url ?? '').split(':');
  const port = Number(portText || 443);
  clientSocket.on('error', () => undefined);
  if (!host || !sandboxFor(req) || !ALLOWED_PORTS.has(port) || !isAllowed(host)) {
    recordDenied(req, host ?? '?', port);
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  clientSocket.on('close', () => upstream.destroy());
});

forward.listen(FORWARD_PORT, BIND_HOST, () => log({ msg: 'forward proxy listening', host: BIND_HOST, port: FORWARD_PORT }));

// ── credential proxy :8080 ────────────────────────────────────────────────────
const credentials = http.createServer((req, res) => {
  if (req.url === '/healthz') return res.writeHead(200).end('ok');
  // /t/<token>/<route>/... (token-identified) or /<route>/... (IP-identified container sandboxes)
  let parts = (req.url ?? '/').split('/').slice(1);
  let sandbox;
  if (parts[0] === 't' && parts[1]) {
    sandbox = policy.tokens?.[parts[1]];
    parts = parts.slice(2);
  } else {
    sandbox = policy.sandboxes[clientIp(req.socket)];
  }
  const [routeName, ...rest] = parts;
  const route = policy.routes[routeName ?? ''];
  if (!sandbox || !route || !sandbox.routes?.includes(routeName)) {
    res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'cocoon: unknown sandbox or route' }));
    return;
  }

  // Swap placeholders of this sandbox for the real secret values (also inside Basic credentials).
  const headers = swapHeaders(req.headers, sandbox.token, route.secrets);
  if (route.inject) headers[route.inject.header] = route.inject.value;
  const path = rest.join('/').split('?')[0];
  if (route.translate && req.method === 'POST') {
    const from = route.translate.from;
    if (from === 'messages' && path.endsWith('messages/count_tokens')) return void readJson(req).then((body) => sendJson(res, 200, countTokens(body)));
    if ((from === 'messages' && path.endsWith('messages')) || (from === 'responses' && path.endsWith('responses'))) {
      return void translate(req, res, route, routeName).catch((err) => {
        log({ msg: 'translation failed', route: routeName, error: err.message });
        if (!res.headersSent) sendJson(res, 502, apiError(from, `CoCoon translation failed: ${err.message}`));
        else res.end();
      });
    }
  }
  const upstreamUrl = new URL(route.upstream);
  headers.host = upstreamUrl.host;
  delete headers['proxy-connection'];

  const basePath = upstreamUrl.pathname.replace(/\/$/, '');
  const secure = upstreamUrl.protocol === 'https:';
  const upstream = (secure ? https : http).request(
    {
      host: upstreamUrl.hostname,
      port: upstreamUrl.port || (secure ? 443 : 80),
      path: `${basePath}/${rest.join('/')}`,
      method: req.method,
      headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    log({ msg: 'credential upstream error', route: routeName, error: err.message });
    if (res.headersSent) res.destroy();
    else res.writeHead(502).end();
  });
  req.pipe(upstream);
});

credentials.listen(CREDENTIAL_PORT, BIND_HOST, () => log({ msg: 'credential proxy listening', host: BIND_HOST, port: CREDENTIAL_PORT }));

// ── API translation (Claude Code → chat-only servers, Codex → chat-only servers) ───

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const apiError = (from, message) =>
  from === 'messages' ? { type: 'error', error: { type: 'api_error', message } } : { error: { type: 'server_error', message } };

/** Calls the upstream Chat Completions endpoint and returns the response stream. */
function postChat(route, chat) {
  const url = new URL(`${route.upstream}${route.translate.chatPath}`);
  const secure = url.protocol === 'https:';
  const headers = { 'content-type': 'application/json', accept: chat.stream ? 'text/event-stream' : 'application/json' };
  if (route.inject) headers[route.inject.header] = route.inject.value;
  return new Promise((resolve, reject) => {
    const upstream = (secure ? https : http).request(
      { host: url.hostname, port: url.port || (secure ? 443 : 80), path: url.pathname + url.search, method: 'POST', headers },
      resolve,
    );
    upstream.on('error', reject);
    upstream.end(JSON.stringify(chat));
  });
}

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function translate(req, res, route, routeName) {
  const from = route.translate.from;
  const body = await readJson(req);
  const { chat, customTools } = from === 'messages' ? { chat: messagesToChat(body), customTools: new Set() } : responsesToChat(body);
  // Cap the answer length to what the model can return (known from its context window).
  const cap = route.translate.maxTokens?.[chat.model];
  if (cap) chat.max_tokens = Math.min(chat.max_tokens ?? cap, cap);
  const upstream = await postChat(route, chat);
  if ((upstream.statusCode ?? 500) >= 400) {
    const text = await readAll(upstream);
    let message = text.slice(0, 500);
    try {
      const json = JSON.parse(text);
      message = json.error?.message ?? json.detail ?? json.message ?? message;
    } catch {
      // keep raw text
    }
    log({ msg: 'upstream error', route: routeName, status: upstream.statusCode, message });
    return sendJson(res, upstream.statusCode ?? 502, apiError(from, String(message)));
  }
  if (chat.stream) {
    return from === 'messages' ? streamChatAsMessages(upstream, res, body.model) : streamChatAsResponses(upstream, res, body.model, customTools);
  }
  const result = JSON.parse(await readAll(upstream));
  return sendJson(res, 200, from === 'messages' ? chatToMessage(result, body.model) : chatToResponse(result, body.model, customTools));
}
