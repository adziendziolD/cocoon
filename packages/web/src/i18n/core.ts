import type { Language } from '@cocoon/protocol';
import { de, en, type MessageKey } from './dictionaries';

export type { Language, MessageKey };
export type TParams = Record<string, string | number>;
/** Translate function: `t('key', { name: 'x', count: 3 })`. */
export type TFunction = (key: MessageKey, params?: TParams) => string;

const DICTS: Record<Language, Record<MessageKey, string>> = { de, en };
const STORAGE_KEY = 'cocoon.lang';

export const LOCALES: Record<Language, string> = { de: 'de-DE', en: 'en-US' };

/** The language chosen in this browser, otherwise the browser language (German or English, falling back to English). */
function detectLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'de' || stored === 'en') return stored;
  } catch {
    // localStorage unavailable (privacy mode) – fall back to the browser language.
  }
  const nav = typeof navigator !== 'undefined' ? (navigator.languages?.[0] ?? navigator.language ?? '') : '';
  return nav.toLowerCase().startsWith('de') ? 'de' : 'en';
}

let current: Language = detectLanguage();
const listeners = new Set<() => void>();

/** Active UI language (also readable outside React, e.g. in rpc()). */
export function getLanguage(): Language {
  return current;
}

export function getLocale(lang: Language = current): string {
  return LOCALES[lang];
}

export function setLanguage(lang: Language): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
  for (const fn of listeners) fn();
}

export function subscribeLanguage(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const pluralRules: Partial<Record<Language, Intl.PluralRules>> = {};

/**
 * Looks up a message and fills in `{name}` placeholders.
 * Plurals: a message "one|other" (e.g. "{count} Sandbox|{count} Sandboxes") picks the form by `params.count`.
 * A three-part message "zero|one|other" additionally has a form for 0.
 */
export function translate(lang: Language, key: MessageKey, params?: TParams): string {
  let text: string = DICTS[lang][key] ?? DICTS.de[key] ?? key;
  if (text.includes('|') && params && typeof params.count === 'number') {
    const forms = text.split('|');
    const n = params.count;
    const rules = (pluralRules[lang] ??= new Intl.PluralRules(LOCALES[lang]));
    if (forms.length >= 3 && n === 0) text = forms[0]!;
    else {
      const [one, other] = forms.length >= 3 ? [forms[1]!, forms[2]!] : [forms[0]!, forms[1] ?? forms[0]!];
      text = rules.select(n) === 'one' ? one : other;
    }
  }
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = params[name];
    if (v === undefined) return m;
    return typeof v === 'number' ? v.toLocaleString(LOCALES[lang]) : v;
  });
}

/** Translation with the current language – for code outside React components (toasts from lib code, errors). */
export const t: TFunction = (key, params) => translate(current, key, params);
