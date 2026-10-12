import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { NotificationEvent, type MethodResult, type Settings } from '@cocoon/protocol';
import { BellRing, Send, Webhook } from 'lucide-react';
import { qk } from '../../api/keys';
import { useSettings } from '../../api/queries';
import { rpc } from '../../api/rpc';
import { useAction } from '../../api/useAction';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { Checkbox, Field, Input } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { SaveBar } from '../../components/SaveBar';
import { ErrorState, LoadingState } from '../../components/States';
import { rich, useT, type MessageKey } from '../../i18n';
import { useDraft } from '../../lib/useDraft';

interface Form {
  webhookUrl: string;
  events: NotificationEvent[];
}

type TestResult = MethodResult<'notifications.test'>;

const EVENTS = NotificationEvent.options;

const EXAMPLES: Array<{ id: string; title: MessageKey; how: MessageKey; url: string }> = [
  { id: 'slack', title: 'notifications.ex.slack', how: 'notifications.ex.slackHow', url: 'https://hooks.slack.com/services/T000/B000/XXXX' },
  { id: 'discord', title: 'notifications.ex.discord', how: 'notifications.ex.discordHow', url: 'https://discord.com/api/webhooks/123456/abcdef/slack' },
  { id: 'teams', title: 'notifications.ex.teams', how: 'notifications.ex.teamsHow', url: 'https://prod-00.westeurope.logic.azure.com/workflows/…' },
  { id: 'other', title: 'notifications.ex.other', how: 'notifications.ex.otherHow', url: 'https://mattermost.example.com/hooks/xxxx' },
];

const toForm = (s: Settings): Form => ({ webhookUrl: s.notifications.webhookUrl ?? '', events: [...s.notifications.events] });

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export function NotificationsSettings() {
  const t = useT();
  const qc = useQueryClient();
  const settings = useSettings();
  const { draft, setDraft, dirty, reset } = useDraft(settings.data ? toForm(settings.data) : undefined);
  const [result, setResult] = useState<TestResult | null>(null);
  const savedUrl = settings.data?.notifications.webhookUrl;

  const save = useAction(
    async (form: Form) => {
      const url = form.webhookUrl.trim();
      const events = EVENTS.filter((e) => form.events.includes(e));
      // A shallow merge can't remove the URL – reset the section first, then write the events back.
      if (!url && savedUrl) {
        await rpc('settings.reset', { section: 'notifications' });
        return rpc('settings.update', { notifications: { events } });
      }
      return rpc('settings.update', { notifications: { webhookUrl: url || undefined, events } });
    },
    {
      success: t('notifications.saved'),
      error: t('saveSettings.saveFailed'),
      invalidate: [qk.setup],
      onSuccess: (next) => {
        qc.setQueryData(qk.settings, next);
        reset(toForm(next));
      },
    },
  );

  const test = useAction((webhookUrl: string | undefined) => rpc('notifications.test', { webhookUrl }), {
    error: t('notifications.test.failed'),
    onSuccess: setResult,
  });

  if (settings.isLoading || !draft) return settings.error ? <ErrorState error={settings.error} onRetry={() => settings.refetch()} /> : <LoadingState />;

  const url = draft.webhookUrl.trim();
  const urlError = url && !isHttpUrl(url) ? t('notifications.url.invalid') : undefined;
  const toggle = (e: NotificationEvent, on: boolean) => setDraft({ ...draft, events: on ? [...draft.events, e] : draft.events.filter((x) => x !== e) });

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader icon={<Webhook className="size-4.5" />} title={t('notifications.webhook.title')} description={t('notifications.webhook.description')} />
        <CardBody className="space-y-5">
          <p className="text-sm leading-relaxed text-fg-muted">
            {rich(t('notifications.webhook.explain'), { json: <code className="rounded bg-surface-2 px-1 font-mono text-xs">{'{ text, event, … }'}</code> })}
          </p>

          <Field label={t('notifications.url.label')} error={urlError} hint={t('notifications.url.hint')}>
            <div className="flex flex-wrap gap-2">
              <Input
                value={draft.webhookUrl}
                onChange={(e) => {
                  setDraft({ ...draft, webhookUrl: e.target.value });
                  setResult(null);
                }}
                placeholder="https://hooks.slack.com/services/…"
                className="min-w-0 flex-1 font-mono"
                invalid={!!urlError}
                type="url"
                spellCheck={false}
              />
              <Button icon={<Send className="size-4" />} loading={test.isPending} disabled={!url || !!urlError} onClick={() => test.mutate(url || undefined)}>
                {t('notifications.test.button')}
              </Button>
            </div>
          </Field>

          {result &&
            (result.ok ? (
              <Callout tone="success" title={t('notifications.test.ok')}>
                {result.message}
              </Callout>
            ) : (
              <Callout
                tone="danger"
                title={
                  <>
                    {t('notifications.test.error')}
                    {result.status !== undefined && <span className="ml-2 font-mono text-xs font-normal text-fg-subtle">HTTP {result.status}</span>}
                  </>
                }
              >
                <span className="break-words">{result.message}</span>
              </Callout>
            ))}

          {!url && (
            <Callout tone="warning" title={t('notifications.off.title')}>
              {savedUrl ? t('notifications.off.cleared') : t('notifications.off.text')}
            </Callout>
          )}

          <div>
            <div className="mb-2 text-sm font-medium text-fg">{t('notifications.ex.title')}</div>
            <div className="grid gap-3 md:grid-cols-2">
              {EXAMPLES.map((ex) => (
                <div key={ex.id} className="rounded-xl border border-line p-3.5">
                  <div className="text-sm font-medium text-fg">{t(ex.title)}</div>
                  <p className="mt-1 text-xs leading-relaxed text-fg-muted">
                    {rich(t(ex.how), { slack: <code className="rounded bg-surface-2 px-1 font-mono">/slack</code> })}
                  </p>
                  <code className="mt-2 block truncate rounded bg-surface-2 px-2 py-1 font-mono text-[11px] text-fg-muted" title={ex.url}>
                    {ex.url}
                  </code>
                </div>
              ))}
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader icon={<BellRing className="size-4.5" />} title={t('notifications.events.title')} description={t('notifications.events.description')} />
        <CardBody className="space-y-3">
          {EVENTS.map((e) => (
            <Checkbox
              key={e}
              checked={draft.events.includes(e)}
              onChange={(on) => toggle(e, on)}
              label={t(`notifications.event.${e}`)}
              description={t(`notifications.event.${e}.hint`)}
            />
          ))}
          {draft.events.length === 0 && <Callout tone="warning">{t('notifications.events.none')}</Callout>}
        </CardBody>
      </Card>

      <SaveBar
        visible={dirty}
        onSave={() => save.mutate(draft)}
        onDiscard={() => {
          reset();
          setResult(null);
        }}
        saving={save.isPending}
        disabled={!!urlError}
        message={urlError ? t('notifications.fixUrl') : undefined}
      />
    </div>
  );
}
