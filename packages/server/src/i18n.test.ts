import { describe, expect, it } from 'vitest';
import { isMessageKey, messages, resolveLanguage, setFallbackLanguage, t, withLanguage, type MessageKey } from './i18n.ts';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const entries = Object.entries(messages) as [MessageKey, Record<string, string>][];

describe('i18n messages', () => {
  it('has messages', () => {
    expect(entries.length).toBeGreaterThan(10);
  });

  it.each(entries)('%s has non-empty de and en texts and nothing else', (_key, texts) => {
    expect(Object.keys(texts).sort()).toEqual(['de', 'en']);
    expect(texts.de?.trim()).toBeTruthy();
    expect(texts.en?.trim()).toBeTruthy();
  });

  it.each(entries)('%s uses the same placeholders in de and en', (_key, texts) => {
    expect(placeholders(texts.de!)).toEqual(placeholders(texts.en!));
  });
});

describe('t', () => {
  it('substitutes placeholders and leaves unknown ones visible', () => {
    expect(t('error.notFound', { what: 'Sandbox', id: 'sb-1' }, 'en')).toBe('Sandbox sb-1 not found');
    expect(t('error.notFound', { what: 'Sandbox', id: 'sb-1' }, 'de')).toBe('Sandbox sb-1 nicht gefunden');
    expect(t('error.notFound', { what: 'Sandbox' }, 'en')).toBe('Sandbox {id} not found');
    expect(t('error.exitCode', { code: 0 }, 'en')).toBe('exit code 0');
  });

  it('uses the request language, then the fallback language', () => {
    setFallbackLanguage(() => 'de');
    try {
      expect(t('error.unauthorized')).toBe('Ungültiger oder fehlender Zugangs-Token');
      expect(withLanguage('en', () => t('error.unauthorized'))).toBe('Invalid or missing access token');
    } finally {
      setFallbackLanguage(() => 'en');
    }
  });

  it('recognizes message keys without prototype keys', () => {
    expect(isMessageKey('error.notFound')).toBe(true);
    expect(isMessageKey('error.nope')).toBe(false);
    expect(isMessageKey('toString')).toBe(false);
  });
});

describe('resolveLanguage', () => {
  it('prefers explicit choice, then Accept-Language, then the server default', () => {
    expect(resolveLanguage('de', 'en-US,en;q=0.9')).toBe('de');
    expect(resolveLanguage(undefined, 'de-DE,de;q=0.9,en;q=0.8')).toBe('de');
    expect(resolveLanguage('fr', 'EN-gb')).toBe('en');
    expect(resolveLanguage(undefined, 'fr-FR,de;q=0.5')).toBe('en');
    expect(resolveLanguage()).toBe('en');
  });
});
