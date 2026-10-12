import type { Language } from '@cocoon/protocol';
import { useLanguage, useT } from '../i18n';
import { cn } from '../lib/cn';

const LANGS: Language[] = ['de', 'en'];

/** Compact "DE | EN" toggle for the UI language (stored in this browser). */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { lang, setLang } = useLanguage();
  const t = useT();
  return (
    <div role="group" aria-label={t('lang.label')} className={cn('inline-flex rounded-md bg-surface-2 p-0.5 text-[11px] font-semibold', className)}>
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          aria-pressed={lang === l}
          title={t('lang.switchTo', { language: t(`lang.${l}`) })}
          className={cn(
            'rounded px-2 py-0.5 uppercase transition-colors',
            lang === l ? 'bg-surface text-fg shadow-sm ring-1 ring-line' : 'text-fg-subtle hover:text-fg',
          )}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
