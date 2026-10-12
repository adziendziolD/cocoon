import type { Settings } from '@cocoon/protocol';
import { useSettings } from '../../api/queries';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { Field, Input } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { SaveBar } from '../../components/SaveBar';
import { ErrorState, LoadingState } from '../../components/States';
import { useT } from '../../i18n';
import { useDraft } from '../../lib/useDraft';
import { useSaveSettings } from './useSaveSettings';

type Draft = Pick<Settings, 'status' | 'git'>;

export function AdvancedSettings() {
  const t = useT();
  const settings = useSettings();
  const source = settings.data ? { status: settings.data.status, git: settings.data.git } : undefined;
  const { draft, setDraft, dirty, reset } = useDraft<Draft>(source);
  const save = useSaveSettings(undefined, (s) => reset({ status: s.status, git: s.git }));

  if (settings.error) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  if (!draft) return <LoadingState />;

  const pollErr = draft.status.pollIntervalMs < 200 ? t('advanced.minPoll') : undefined;
  const idleErr = draft.status.idleAfterMs < 500 ? t('advanced.minIdle') : undefined;
  const ms = (v: string) => Math.round(Number(v) || 0);

  return (
    <div className="space-y-6">
      <Callout tone="warning">{t('advanced.warning')}</Callout>
      <Card>
        <CardHeader title={t('advanced.status.title')} description={t('advanced.status.description')} />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label={t('advanced.status.poll')} error={pollErr} hint={t('advanced.status.pollHint')}>
            <Input type="number" min={200} step={100} value={draft.status.pollIntervalMs} onChange={(e) => setDraft({ ...draft, status: { ...draft.status, pollIntervalMs: ms(e.target.value) } })} />
          </Field>
          <Field label={t('advanced.status.idle')} error={idleErr} hint={t('advanced.status.idleHint')}>
            <Input type="number" min={500} step={100} value={draft.status.idleAfterMs} onChange={(e) => setDraft({ ...draft, status: { ...draft.status, idleAfterMs: ms(e.target.value) } })} />
          </Field>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={t('advanced.git.title')} description={t('advanced.git.description')} />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label={t('common.name')}>
            <Input value={draft.git.authorName} onChange={(e) => setDraft({ ...draft, git: { ...draft.git, authorName: e.target.value } })} />
          </Field>
          <Field label={t('advanced.git.email')} hint={t('advanced.git.emailHint')}>
            <Input type="email" value={draft.git.authorEmail} onChange={(e) => setDraft({ ...draft, git: { ...draft.git, authorEmail: e.target.value } })} />
          </Field>
        </CardBody>
      </Card>
      <SaveBar visible={dirty} onSave={() => save.mutate(draft)} onDiscard={() => reset()} saving={save.isPending} disabled={!!pollErr || !!idleErr} />
    </div>
  );
}
