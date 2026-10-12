import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Agent } from '@cocoon/protocol';
import { ArrowRightLeft, Play } from 'lucide-react';
import { qk } from '../api/keys';
import { useSandbox, useSettings } from '../api/queries';
import { rpc } from '../api/rpc';
import { useAction } from '../api/useAction';
import { rich, useLanguage, useT } from '../i18n';
import { profileLabel } from '../lib/profiles';
import { AgentLaunchFields, EMPTY_CHOICE, launchLimits, launchModel, useLaunchInfo, type LaunchChoice } from './AgentLaunchFields';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Checkbox, Field, Textarea } from './Field';
import { Callout } from './HelpText';
import { LoadingState } from './States';

/**
 * "Agent wechseln": starts another agent type / provider / model in the same sandbox, optionally hands over
 * the previous task, changed files and last output, and stops the previous agent.
 * For exited agents the same dialog reads "start a new agent in this sandbox".
 */
export function SwitchAgentDialog({ agent, open, onClose, onSwitched }: { agent: Agent; open: boolean; onClose: () => void; onSwitched: (next: Agent) => void }) {
  const t = useT();
  const { lang } = useLanguage();
  const qc = useQueryClient();
  const settings = useSettings();
  const sandbox = useSandbox(agent.sandboxId);
  const exited = agent.status === 'exited';
  const [choice, setChoice] = useState<LaunchChoice>(EMPTY_CHOICE);
  const [handover, setHandover] = useState(true);
  const [stopPrevious, setStopPrevious] = useState(true);
  const [prompt, setPrompt] = useState('');
  const info = useLaunchInfo(choice);
  const current = profileLabel(agent.kind, settings.data?.agents[agent.kind], lang);

  useEffect(() => {
    if (!open) return;
    setChoice(EMPTY_CHOICE);
    setHandover(true);
    setStopPrevious(true);
    setPrompt('');
  }, [open]);

  const running = sandbox.data?.status === 'running' || sandbox.data === undefined;
  const sw = useAction(
    () =>
      rpc('agent.switch', {
        agentId: agent.id,
        kind: choice.kind,
        providers: choice.providers ?? undefined,
        model: launchModel(choice, info),
        ...launchLimits(choice),
        handover,
        prompt: prompt.trim() || undefined,
        stopPrevious: exited ? false : stopPrevious,
      }),
    {
      success: t('switch.done'),
      error: t('switch.failed'),
      invalidate: [qk.agents, qk.agent(agent.id)],
      onSuccess: (next) => {
        // Known right away, so the cockpit pane / detail page doesn't flash "agent gone".
        qc.setQueryData<Agent[]>(qk.agents, (old) => (old && !old.some((a) => a.id === next.id) ? [...old, next] : old));
        qc.setQueryData(qk.agent(next.id), next);
        onClose();
        onSwitched(next);
      },
    },
  );

  const canGo = running && !info.problem && !info.isShell;
  const go = () => canGo && sw.mutate();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      dismissable={!sw.isPending}
      title={exited ? t('switch.titleExited') : t('switch.title')}
      description={rich(t(exited ? 'switch.explainExited' : 'switch.explain'), { agent: <strong className="text-fg">{current}</strong> })}
      footer={
        <>
          {info.problem && choice.kind && <span className="mr-auto self-center text-xs text-amber-700 dark:text-amber-400">{info.problem}</span>}
          <Button onClick={onClose} disabled={sw.isPending}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon={exited ? <Play className="size-4" /> : <ArrowRightLeft className="size-4" />} loading={sw.isPending} disabled={!canGo} onClick={go}>
            {exited ? t('switch.startExited') : t('switch.confirm')}
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
          <AgentLaunchFields choice={choice} onChange={setChoice} info={info} onNavigate={onClose} heading={t('switch.whichAgent')} />
          {info.isShell && <Callout tone="info">{t('switch.shellNote')}</Callout>}

          <div className="space-y-3 rounded-xl border border-line px-4 py-3.5">
            <Checkbox checked={handover} onChange={setHandover} label={t('switch.handover')} description={t('switch.handoverHint')} />
            <Field label={t('switch.prompt')} optional hint={handover ? t('switch.promptHintHandover') : t('switch.promptHint')}>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                placeholder={t('switch.promptPlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go();
                }}
              />
            </Field>
            {!exited && <Checkbox checked={stopPrevious} onChange={setStopPrevious} label={t('switch.stopPrevious', { agent: current })} description={t('switch.stopPreviousHint')} />}
          </div>
        </div>
      )}
    </Dialog>
  );
}
