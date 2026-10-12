import type { CocoonClient } from './client.ts';

/** Interactive terminal bridge. Detach with tmux's own binding: Ctrl-b d. */
export function attach(client: CocoonClient, agentId: string): Promise<void> {
  const { stdin, stdout } = process;
  const ws = client.socket(`/v1/agents/${agentId}/attach`, { cols: stdout.columns ?? 120, rows: stdout.rows ?? 40 });

  return new Promise((resolve, reject) => {
    const sendResize = () => ws.send(JSON.stringify({ type: 'resize', cols: stdout.columns, rows: stdout.rows }));
    const onInput = (chunk: Buffer) => ws.send(chunk, { binary: true });
    const cleanup = () => {
      stdin.off('data', onInput);
      stdout.off('resize', sendResize);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };

    ws.on('open', () => {
      if (stdin.isTTY) stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onInput);
      stdout.on('resize', sendResize);
    });
    ws.on('message', (data: Buffer) => stdout.write(data));
    ws.on('close', (code, reason) => {
      cleanup();
      if (code >= 4000) reject(new Error(reason.toString()));
      else resolve();
    });
    ws.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}
