import type { Language } from '@cocoon/protocol';
import { Bot, Box, Hand, Languages, Sparkles } from 'lucide-react';
import { useSettings } from '../../../api/queries';
import { Checkbox, ChoiceCard } from '../../../components/Field';
import { useLanguage, useT } from '../../../i18n';
import { useSaveSettings } from '../../settings/useSaveSettings';
import { useDraftField, useOnboarding } from '../context';
import { STEP_IDS, STEP_LABELS } from '../state';
import { StepFrame } from '../StepFrame';

const LANGS: Language[] = ['de', 'en'];

const POINTS = [
  { icon: Box, title: 'onboarding.welcome.sandboxTitle', text: 'onboarding.welcome.sandboxText', tint: 'from-sky-500/15 to-indigo-500/10 text-sky-600 dark:text-sky-400' },
  { icon: Bot, title: 'onboarding.welcome.agentTitle', text: 'onboarding.welcome.agentText', tint: 'from-violet-500/15 to-fuchsia-500/10 text-violet-600 dark:text-violet-400' },
  { icon: Hand, title: 'onboarding.welcome.controlTitle', text: 'onboarding.welcome.controlText', tint: 'from-emerald-500/15 to-teal-500/10 text-emerald-600 dark:text-emerald-400' },
] as const;

export function WelcomeStep() {
  const t = useT();
  const { lang, setLang } = useLanguage();
  const { next } = useOnboarding();
  const settings = useSettings();
  const [alsoServer, setAlsoServer] = useDraftField('welcome.alsoServer', true);
  const save = useSaveSettings(t('general.serverSaved'), () => next());
  const serverLang = settings.data?.general.language;

  const goNext = () => {
    if (alsoServer && settings.data && serverLang !== lang) save.mutate({ general: { language: lang } });
    else next();
  };

  return (
    <StepFrame
      icon={Sparkles}
      title={t('onboarding.welcome.title')}
      lead={t('onboarding.welcome.lead')}
      hideBack
      onNext={goNext}
      nextLoading={save.isPending}
      nextLabel={t('onboarding.welcome.start')}
      doneBanner={false}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {POINTS.map(({ icon: Icon, title, text, tint }) => (
          <div key={title} className="rounded-xl border border-line bg-surface-2/40 p-4">
            <div className={`mb-3 flex size-12 items-center justify-center rounded-2xl bg-gradient-to-br ${tint}`}>
              <Icon className="size-6" />
            </div>
            <div className="font-medium text-fg">{t(title)}</div>
            <p className="mt-1 text-sm leading-relaxed text-fg-muted">{t(text)}</p>
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-line px-4 py-3.5">
        <div className="text-sm font-medium text-fg">{t('onboarding.welcome.planTitle')}</div>
        <p className="mt-0.5 text-sm text-fg-muted">{t('onboarding.welcome.planText')}</p>
        <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-fg-muted">
          {STEP_IDS.slice(1, -1).map((id, i) => (
            <li key={id} className="flex items-center gap-1.5">
              <span className="flex size-5 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">{i + 1}</span>
              {t(STEP_LABELS[id])}
              {id === 'github' && <span className="text-fg-subtle">{t('common.optional')}</span>}
            </li>
          ))}
        </ol>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-fg">
          <Languages className="size-4 text-fg-muted" />
          {t('onboarding.welcome.languageTitle')}
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {LANGS.map((l) => (
            <ChoiceCard key={l} selected={lang === l} onSelect={() => setLang(l)} title={t(`lang.${l}`)} description={t(`general.lang.${l}.hint`)} />
          ))}
        </div>
        <div className="mt-3">
          <Checkbox checked={alsoServer} onChange={setAlsoServer} label={t('onboarding.welcome.alsoServer')} description={t('onboarding.welcome.alsoServerHint')} />
        </div>
      </div>
    </StepFrame>
  );
}
