import WebSocket from 'ws';
import type { CocoonEvent, EventFilter, MethodName, MethodParams, MethodResult, WireError } from '@cocoon/protocol';

export class CocoonApiError extends Error {
  constructor(readonly error: WireError) {
    super(`${error.code}: ${error.message}`);
  }
}

/** Thin typed client for the cocoond control API. Usable from scripts and other agents too. */
export class CocoonClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    /** Language for server messages ("de" | "en"); defaults to the server setting. */
    private readonly lang?: string,
  ) {}

  async call<M extends MethodName>(method: M, params?: MethodParams<M>): Promise<MethodResult<M>> {
    return (await this.raw(method, params)) as MethodResult<M>;
  }

  async raw(method: string, params: unknown = {}): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/v1/rpc/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...(this.lang ? { 'x-cocoon-lang': this.lang } : {}),
      },
      body: JSON.stringify(params ?? {}),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: WireError };
    if (!res.ok || body.error) throw new CocoonApiError(body.error ?? { code: 'internal', message: `HTTP ${res.status}` });
    return body.result;
  }

  /** Streams events until the returned function is called. */
  subscribe(filter: EventFilter, onEvent: (event: CocoonEvent) => void, onClose?: (reason: string) => void): () => void {
    const ws = this.socket('/v1/ws');
    ws.on('open', () => ws.send(JSON.stringify({ id: 'events', method: 'events.subscribe', params: filter })));
    // Errors end the stream through onClose: thrown inside a socket handler they would be uncaught exceptions.
    let closed = false;
    const finish = (reason: string) => {
      if (closed) return;
      closed = true;
      onClose?.(reason);
    };
    ws.on('message', (data) => {
      let msg: { event?: CocoonEvent; error?: WireError };
      try {
        msg = JSON.parse(data.toString()) as typeof msg;
      } catch {
        return; // not a frame of ours
      }
      if (msg.error) {
        finish(new CocoonApiError(msg.error).message);
        ws.close();
      } else if (msg.event) onEvent(msg.event);
    });
    ws.on('error', (err) => finish(err.message));
    ws.on('close', (_code, reason) => finish(reason.toString()));
    return () => ws.close();
  }

  socket(path: string, query: Record<string, string | number> = {}): WebSocket {
    const url = new URL(path, this.baseUrl.replace(/^http/, 'ws'));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    if (this.lang) url.searchParams.set('lang', this.lang);
    return new WebSocket(url, { headers: { authorization: `Bearer ${this.token}` } });
  }
}
