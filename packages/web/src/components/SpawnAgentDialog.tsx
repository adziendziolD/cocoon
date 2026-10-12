import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Sandbox } from '@cocoon/protocol';
import { Play } from 'lucide-react';
import { qk } from '../api/keys';
import { useSettings } from '../api/queries';
import { rpc } from '../api/rpc';
import { useAction } from '../api/useAction';
import { rich, useT } from '../i18n';
import { AgentLaunchFields, EMPTY_CHOICE, launchLimits, launchModel, useLaunchInfo, type LaunchChoice } from './AgentLaunchFields';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Field, Textarea } from './Field';
import { Callout } from './HelpText';
import { LoadingState } from './States';

export { profileDescription, profileLabel } from '../lib/profiles';

interface SpawnVars {
  kind: string;
  prompt?: string;
  providers?: string[];
  model?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** Dialog to start an agent in a sandbox: choose type (and model), describe the task, go. */
export function SpawnAgentDialog({ sandbox, open, onClose }: { sandbox: Sandbox; open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const t = useT();
  const settings = useSettings();
  const [choice, setChoice] = useState<LaunchChoice>(EMPTY_CHOICE);
  const [prompt, setPrompt] = useState('');
  const info = useLaunchInfo(choice);

  useEffect(() => {
    if (!open) return;
    setPrompt('');
    // Keep the last chosen type (if it still exists) – never pick one for the user.
    setChoice((c) => ({ ...EMPTY_CHOICE, kind: c.kind && settings.data?.agents[c.kind] ? c.kind : '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const running = sandbox.status === 'running';

  const spawn = useAction((v: SpawnVars) => rpc('agent.spawn', { sandboxId: sandbox.id, ...v }), {
    success: t('spawn.started'),
    error: t('spawn.failed'),
    invalidate: [qk.agents, qk.setup],
    onSuccess: (agent) => {
      onClose();
      navigate(`/agents/${agent.id}`);
    },
  });

  const canStart = running && !info.problem;
  const go = () => {
    if (!canStart) return;
    spawn.mutate({
      kind: choice.kind,
      prompt: prompt.trim() || undefined,
      providers: choice.providers ?? undefined,
      model: launchModel(choice, info),
      ...launchLimits(choice),
    });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      dismissable={!spawn.isPending}
      title={t('spawn.title')}
      description={rich(t('spawn.description'), { sandbox: <strong className="text-fg">{sandbox.name}</strong> })}
      footer={
        <>
          {info.problem && choice.kind && <span className="mr-auto self-center text-xs text-amber-700 dark:text-amber-400">{info.problem}</span>}
          <Button onClick={onClose} disabled={spawn.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon={<Play className="size-4" />} loading={spawn.isPending} disabled={!canStart} onClick={go}>
            {t('spawn.title')}
          </Button>
        </>
      }
    >
      {info.loading ? (
        <LoadingState />
      ) : (
        <div className="space-y-5">
          {!running && (
            <Callout tone="warning" title={t('spawn.notRunning')}>
              {t('spawn.notRunningText')}
            </Callout>
          )}
          <AgentLaunchFields choice={choice} onChange={setChoice} info={info} onNavigate={onClose} />

          {choice.kind && (
            <Field
              label={info.isShell ? t('spawn.command') : t('spawn.whatToDo')}
              optional
              hint={info.isShell ? t('spawn.commandHint') : t('spawn.whatToDoHint')}
            >
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={info.isShell ? 2 : 5}
                className={info.isShell ? 'font-mono' : undefined}
                placeholder={info.isShell ? 'npm test' : t('spawn.promptPlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go();
                }}
              />
            </Field>
          )}
        </div>
      )}
    </Dialog>
  );
}
