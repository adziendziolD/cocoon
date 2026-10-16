import { cronError, nextCronRuns, type Language, type ScheduleTemplate } from '@cocoon/protocol';
import type { TFunction } from '../i18n';

/** The friendly schedule picker; everything else is a raw cron expression ("custom"). */
export type Frequency =
  | { kind: 'hourly'; every: number; minute: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'monthly'; day: number; time: string }
  | { kind: 'custom'; cron: string };

export type FrequencyKind = Frequency['kind'];
export const FREQUENCY_KINDS: FrequencyKind[] = ['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom'];
export const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12];
/** Monday first, as people read a week here (0 = Sunday). */
export const WEEK = [1, 2, 3, 4, 5, 6, 0];
export const TEMPLATE_ORDER: ScheduleTemplate[] = ['checks', 'dependencies', 'security', 'custom'];

const pad = (n: number) => String(n).padStart(2, '0');
const splitTime = (time: string): [number, number] => {
  const [h = '0', m = '0'] = time.split(':');
  return [Math.min(23, Math.max(0, Number(h) || 0)), Math.min(59, Math.max(0, Number(m) || 0))];
};

export function toCron(f: Frequency): string {
  if (f.kind === 'custom') return f.cron.trim();
  if (f.kind === 'hourly') return `${f.minute} ${f.every > 1 ? `*/${f.every}` : '*'} * * *`;
  const [h, m] = splitTime(f.time);
  switch (f.kind) {
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekdays':
      return `${m} ${h} * * 1-5`;
    case 'weekly':
      return `${m} ${h} * * ${[...f.days].sort((a, b) => a - b).join(',') || '1'}`;
    case 'monthly':
      return `${m} ${h} ${f.day} * *`;
  }
}

/** The friendly form of a cron expression, if it has one. */
export function fromCron(cron: string): Frequency {
  const c = cron.trim().replace(/\s+/g, ' ');
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2}) \*(?:\/(\d{1,2}))? \* \* \*$/.exec(c)) && Number(m[1]) < 60) {
    const every = m[2] ? Number(m[2]) : 1;
    if (HOUR_STEPS.includes(every)) return { kind: 'hourly', every, minute: Number(m[1]) };
  }
  if ((m = /^(\d{1,2}) (\d{1,2}) (\*|\d{1,2}) \* (\*|1-5|[0-6](?:,[0-6])*)$/.exec(c)) && Number(m[1]) < 60 && Number(m[2]) < 24) {
    const time = `${pad(Number(m[2]))}:${pad(Number(m[1]))}`;
    const [, , , day, weekdays] = m;
    if (day !== '*' && weekdays === '*' && Number(day) >= 1 && Number(day) <= 28) return { kind: 'monthly', day: Number(day), time };
    if (day === '*' && weekdays === '*') return { kind: 'daily', time };
    if (day === '*' && weekdays === '1-5') return { kind: 'weekdays', time };
    if (day === '*' && weekdays !== '1-5') return { kind: 'weekly', days: [...new Set(weekdays!.split(',').map(Number))], time };
  }
  return { kind: 'custom', cron: c };
}

/** Switching the picker keeps the time where it can. */
export function switchFrequency(current: Frequency, kind: FrequencyKind): Frequency {
  const time = 'time' in current ? current.time : '03:00';
  switch (kind) {
    case 'hourly':
      return { kind, every: 1, minute: 0 };
    case 'daily':
    case 'weekdays':
      return { kind, time };
    case 'weekly':
      return { kind, days: [1], time };
    case 'monthly':
      return { kind, day: 1, time };
    case 'custom':
      return { kind, cron: toCron(current) };
  }
}

export function weekdayName(day: number, lang: Language, width: 'short' | 'long' = 'short'): string {
  // 2026-10-18 is a Sunday.
  return new Intl.DateTimeFormat(lang, { weekday: width, timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 18 + day)));
}

/** "Daily at 03:00", "Mon, Wed at 09:30", … – or the cron expression itself. */
export function describeCron(t: TFunction, cron: string, lang: Language): string {
  const f = fromCron(cron);
  switch (f.kind) {
    case 'hourly':
      return f.every > 1 ? t('schedule.freq.describe.everyHours', { count: f.every, minute: pad(f.minute) }) : t('schedule.freq.describe.hourly', { minute: pad(f.minute) });
    case 'daily':
      return t('schedule.freq.describe.daily', { time: f.time });
    case 'weekdays':
      return t('schedule.freq.describe.weekdays', { time: f.time });
    case 'weekly':
      return t('schedule.freq.describe.weekly', { days: WEEK.filter((d) => f.days.includes(d)).map((d) => weekdayName(d, lang)).join(', '), time: f.time });
    case 'monthly':
      return t('schedule.freq.describe.monthly', { day: f.day, time: f.time });
    case 'custom':
      return t('schedule.freq.describe.custom', { cron: f.cron });
  }
}

/** Next run times computed in the browser (same code as the server), or the error of an invalid expression. */
export function previewRuns(cron: string, timeZone: string | undefined, count = 3): { error?: string; next: Date[] } {
  const error = cronError(cron);
  if (error) return { error, next: [] };
  try {
    return { next: nextCronRuns(cron, new Date(), count, timeZone || undefined) };
  } catch (err) {
    return { error: (err as Error).message, next: [] };
  }
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** IANA time zones the browser knows (for the picker); falls back to a short list. */
export function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const zones = intl.supportedValuesOf?.('timeZone') ?? ['UTC', 'Europe/Berlin', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo'];
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
}
