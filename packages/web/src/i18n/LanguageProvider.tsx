import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getLanguage, getLocale, setLanguage, subscribeLanguage, translate, type Language, type TFunction } from './core';

interface LanguageContextValue {
  lang: Language;
  locale: string;
  setLang: (lang: Language) => void;
  t: TFunction;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

/**
 * Provides the active UI language. On change it updates <html lang>, refetches all queries
 * (so server-rendered texts like errors and activity messages arrive in the new language)
 * and – via useEventSync, which depends on the language – reconnects the event socket.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const lang = useSyncExternalStore(subscribeLanguage, getLanguage);
  const qc = useQueryClient();
  const first = useRef(true);

  useEffect(() => {
    document.documentElement.lang = lang;
    if (first.current) {
      first.current = false;
      return;
    }
    void qc.invalidateQueries();
  }, [lang, qc]);

  const t = useCallback<TFunction>((key, params) => translate(lang, key, params), [lang]);
  const value = useMemo<LanguageContextValue>(() => ({ lang, locale: getLocale(lang), setLang: setLanguage, t }), [lang, t]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

function useLanguageContext(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useT/useLanguage must be used inside <LanguageProvider>');
  return ctx;
}

/** The translate function for the active language. Components using it re-render on language change. */
export function useT(): TFunction {
  return useLanguageContext().t;
}

/** Active language, its locale ("de-DE" / "en-US") and a setter. */
export function useLanguage(): { lang: Language; locale: string; setLang: (lang: Language) => void } {
  const { lang, locale, setLang } = useLanguageContext();
  return { lang, locale, setLang };
}
