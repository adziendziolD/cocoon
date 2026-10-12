import { useT } from '../i18n';

/** CoCoon logo mark with name and tagline. */
export function Logo({ tagline = true }: { tagline?: boolean }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm">
        <svg viewBox="0 0 24 24" className="size-4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <ellipse cx="12" cy="12" rx="6" ry="9" />
          <path d="M7 8.5c3 1.5 7 1.5 10 0M6.5 13c3.5 1.6 7.5 1.6 11 0" />
        </svg>
      </div>
      <div>
        <div className="text-[15px] leading-none font-semibold text-fg">CoCoon</div>
        {tagline && <div className="mt-0.5 text-[11px] leading-none text-fg-subtle">{t('layout.tagline')}</div>}
      </div>
    </div>
  );
}
