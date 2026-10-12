import { getLanguage, getLocale, t, type Language } from '../i18n';

/**
 * Locale-aware formatting. All functions use the active UI language (de-DE / en-US) unless `lang` is given.
 * Components showing these values should call useT()/useLanguage() so they re-render on a language switch.
 */
const cache = new Map<string, Intl.DateTimeFormat | Intl.RelativeTimeFormat>();

function dtf(lang: Language, kind: 'datetime' | 'time'): Intl.DateTimeFormat {
  const key = `${lang}:${kind}`;
  let f = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!f) {
    f =
      kind === 'datetime'
        ? new Intl.DateTimeFormat(getLocale(lang), { dateStyle: 'medium', timeStyle: 'short' })
        : new Intl.DateTimeFormat(getLocale(lang), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    cache.set(key, f);
  }
  return f;
}

function rtf(lang: Language): Intl.RelativeTimeFormat {
  const key = `${lang}:rel`;
  let f = cache.get(key) as Intl.RelativeTimeFormat | undefined;
  if (!f) {
    f = new Intl.RelativeTimeFormat(getLocale(lang), { numeric: 'auto' });
    cache.set(key, f);
  }
  return f;
}

export function formatDateTime(iso: string | undefined, lang: Language = getLanguage()): string {
  if (!iso) return '–';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dtf(lang, 'datetime').format(d);
}

export function formatTime(iso: string, lang: Language = getLanguage()): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dtf(lang, 'time').format(d);
}

/** "vor 3 Minuten" / "3 minutes ago", "gerade eben" / "just now", … */
export function formatRelative(iso: string | undefined, now = Date.now(), lang: Language = getLanguage()): string {
  if (!iso) return '–';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso;
  const diff = (ts - now) / 1000;
  const abs = Math.abs(diff);
  const f = rtf(lang);
  if (abs < 10) return lang === getLanguage() ? t('format.justNow') : f.format(0, 'second');
  if (abs < 60) return f.format(Math.round(diff), 'second');
  if (abs < 3600) return f.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return f.format(Math.round(diff / 3600), 'hour');
  return f.format(Math.round(diff / 86400), 'day');
}

export function formatNumber(n: number, opts?: Intl.NumberFormatOptions, lang: Language = getLanguage()): string {
  return n.toLocaleString(getLocale(lang), opts);
}

export function formatBytes(bytes: number | undefined, lang: Language = getLanguage()): string {
  if (bytes === undefined || Number.isNaN(bytes)) return '–';
  if (bytes < 1024) return `${formatNumber(bytes, undefined, lang)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${formatNumber(v, { maximumFractionDigits: v < 10 ? 1 : 0 }, lang)} ${units[i]}`;
}

export function formatMemory(mb: number | undefined, lang: Language = getLanguage()): string {
  if (!mb) return '–';
  return mb >= 1024 ? `${formatNumber(mb / 1024, { maximumFractionDigits: 1 }, lang)} GB` : `${formatNumber(mb, undefined, lang)} MB`;
}

export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}
