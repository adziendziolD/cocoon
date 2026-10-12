import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Sandbox } from '@cocoon/protocol';
import { CornerDownLeft, SquareTerminal, Trash2 } from 'lucide-react';
import { qk } from '../../api/keys';
import { describeError, rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { Button } from '../../components/Button';
import { Card, CardHeader } from '../../components/Card';
import { Callout } from '../../components/HelpText';
import { Spinner } from '../../components/States';
import { cn } from '../../lib/cn';
import { useT } from '../../i18n';

interface Run {
  id: number;
  command: string;
  running: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

const EXAMPLES = ['ls -la', 'git log --oneline -n 10', 'cat package.json', 'node --version'];
let runId = 0;

export function ConsoleTab({ sandbox }: { sandbox: Sandbox }) {
  const navigate = useNavigate();
  const t = useT();
  const [input, setInput] = useState('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const busy = runs.some((r) => r.running);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runs]);

  const spawnShell = useAction(() => rpc('agent.spawn', { sandboxId: sandbox.id, kind: 'shell' }), {
    success: t('console.shell.success'),
    error: t('console.shell.error'),
    invalidate: [qk.agents],
    onSuccess: (a) => navigate(`/agents/${a.id}`),
  });

  const run = async (command: string) => {
    const cmd = command.trim();
    if (!cmd || busy) return;
    const id = ++runId;
    setRuns((r) => [...r, { id, command: cmd, running: true }]);
    setInput('');
    setHistoryIdx(null);
    try {
      const res = await rpc('sandbox.exec', { sandboxId: sandbox.id, command: ['sh', '-c', cmd], timeoutMs: 120_000 });
      setRuns((r) => r.map((x) => (x.id === id ? { ...x, running: false, ...res } : x)));
    } catch (err) {
      setRuns((r) => r.map((x) => (x.id === id ? { ...x, running: false, error: describeError(err) } : x)));
    }
  };

  const commands = runs.map((r) => r.command);

  return (
    <div className="space-y-4">
      <Callout
        tone="tip"
        action={
          <Button size="sm" icon={<SquareTerminal className="size-4" />} loading={spawnShell.isPending} onClick={() => spawnShell.mutate()}>
            {t('console.shell.open')}
          </Button>
        }
      >
        {t('console.intro')}
      </Callout>

      <Card className="overflow-hidden">
        <CardHeader
          title={t('console.title')}
          description={<span className="font-mono text-xs">{sandbox.workdir}</span>}
          actions={
            runs.length > 0 && (
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setRuns([])} disabled={busy}>
                {t('console.clear')}
              </Button>
            )
          }
        />
        <div ref={logRef} className="max-h-[60vh] min-h-48 overflow-y-auto bg-gray-950 px-4 py-3 font-mono text-[13px] leading-relaxed text-gray-200">
          {runs.length === 0 && (
            <div className="text-gray-500">
              {t('console.empty')}
              <div className="mt-2 flex flex-wrap gap-2">
                {EXAMPLES.map((ex) => (
                  <button key={ex} onClick={() => run(ex)} className="rounded bg-white/5 px-2 py-0.5 text-gray-300 hover:bg-white/10">
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          )}
          {runs.map((r) => (
            <div key={r.id} className="mb-3">
              <div className="flex items-center gap-2">
                <span className="text-indigo-400">$</span>
                <span className="text-white">{r.command}</span>
                {r.running && <Spinner className="size-3.5" />}
                {r.exitCode !== undefined && (
                  <span className={cn('ml-auto text-xs', r.exitCode === 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {r.exitCode === 0 ? t('console.ok') : t('console.exitCode', { code: String(r.exitCode) })}
                  </span>
                )}
              </div>
              {r.stdout && <pre className="whitespace-pre-wrap break-words">{r.stdout}</pre>}
              {r.stderr && <pre className="whitespace-pre-wrap break-words text-red-300">{r.stderr}</pre>}
              {r.error && <pre className="whitespace-pre-wrap text-red-400">{t('console.error', { error: r.error })}</pre>}
              {!r.running && !r.stdout && !r.stderr && !r.error && <div className="text-gray-500">{t('console.noOutput')}</div>}
            </div>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(input);
          }}
          className="flex items-center gap-2 border-t border-line bg-surface px-3 py-2"
        >
          <span className="font-mono text-accent">$</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // ↑/↓ browse previous commands like in a real shell.
              if (e.key === 'ArrowUp' && commands.length) {
                e.preventDefault();
                const i = historyIdx === null ? commands.length - 1 : Math.max(0, historyIdx - 1);
                setHistoryIdx(i);
                setInput(commands[i] ?? '');
              } else if (e.key === 'ArrowDown' && historyIdx !== null) {
                e.preventDefault();
                const i = historyIdx + 1;
                if (i >= commands.length) {
                  setHistoryIdx(null);
                  setInput('');
                } else {
                  setHistoryIdx(i);
                  setInput(commands[i] ?? '');
                }
              }
            }}
            placeholder={t('console.placeholder')}
            className="h-9 flex-1 bg-transparent font-mono text-sm text-fg outline-none placeholder:text-fg-subtle"
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" size="sm" variant="primary" icon={<CornerDownLeft className="size-3.5" />} disabled={!input.trim() || busy}>
            {t('console.run')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
