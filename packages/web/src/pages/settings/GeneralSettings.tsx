import { useEffect, useState } from 'react';
import type { Language } from '@cocoon/protocol';
import { Languages, Monitor, Server, Wand2 } from 'lucide-react';
import { useSettings } from '../../api/queries';
import { Button } from '../../components/Button';
import { Card, CardBody, CardHeader } from '../../components/Card';
import { ChoiceCard } from '../../components/Field';
import { Callout } from '../../components/HelpText';
import { ErrorState, LoadingState } from '../../components/States';
import { useLanguage, useT } from '../../i18n';
import { formatDateTime } from '../../lib/format';
import { useStartOnboarding } from '../onboarding/lifecycle';
import { useSaveSettings } from './useSaveSettings';

const LANGS: Language[] = ['de', 'en'];

export function GeneralSettings() {
  const t = useT();
  const { lang, setLang } = useLanguage();
  const settings = useSettings();
  const serverLang = settings.data?.general.language ?? 'de';
  const [draft, setDraft] = useState<Language>(serverLang);
  useEffect(() => setDraft(serverLang), [serverLang]);
  const save = useSaveSettings(t('general.serverSaved'));
  const startOnboarding = useStartOnboarding();
  const completedAt = settings.data?.general.onboardingCompletedAt;

  return (
    <div className="space-y-6">
      <Card className="border-accent/30 bg-accent-soft/40">
        <CardBody className="flex flex-wrap items-start gap-4">
          <Wand2 className="mt-0.5 size-5 text-accent" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-fg">{t('onboarding.settings.title')}</h2>
            <p className="mt-0.5 text-sm text-fg-muted">
              {completedAt ? t('onboarding.settings.descriptionDone', { date: formatDateTime(completedAt) }) : t('onboarding.settings.description')}
            </p>
          </div>
          <Button variant="primary" icon={<Wand2 className="size-4" />} onClick={startOnboarding}>
            {t('onboarding.run')}
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader icon={<Monitor className="size-4.5" />} title={t('general.uiTitle')} description={t('general.uiDescription')} />
        <CardBody className="grid gap-2.5 sm:grid-cols-2">
          {LANGS.map((l) => (
            <ChoiceCard
              key={l}
              selected={lang === l}
              onSelect={() => setLang(l)}
              icon={<Languages className="size-5" />}
              title={t(`lang.${l}`)}
              description={t(`general.lang.${l}.hint`)}
            />
          ))}
        </CardBody>
      </Card>

      <Card>
        <CardHeader icon={<Server className="size-4.5" />} title={t('general.serverTitle')} description={t('general.serverDescription')} />
        <CardBody className="space-y-4">
          {settings.isLoading ? (
            <LoadingState />
          ) : settings.error ? (
            <ErrorState error={settings.error} onRetry={() => settings.refetch()} />
          ) : (
            <>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {LANGS.map((l) => (
                  <ChoiceCard key={l} selected={draft === l} onSelect={() => setDraft(l)} title={t(`lang.${l}`)} />
                ))}
              </div>
              <Callout tone="info">{t('general.serverExplain')}</Callout>
              <div className="flex justify-end">
                <Button variant="primary" disabled={draft === serverLang} loading={save.isPending} onClick={() => save.mutate({ general: { language: draft } })}>
                  {t('common.save')}
                </Button>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
