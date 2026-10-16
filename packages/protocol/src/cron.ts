/**
 * Cron expressions for scheduled agents: the classic five fields "minute hour day-of-month month day-of-week"
 * with lists (1,15), ranges (1-5), steps (*\/15, 8-18/2), names (jan, mon) and the macros @hourly, @daily,
 * @weekly, @monthly and @yearly. Times are evaluated in an IANA time zone (daylight saving time included).
 * No dependencies – used by the server (scheduler) and the web UI (preview of the next runs).
 */

export interface CronSpec {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 = Sunday … 6 = Saturday. */
  weekdays: ReadonlySet<number>;
  /** Like in Vixie cron: if both day fields are restricted, a day matches when either of them does. */
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

export class CronError extends Error {}

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldDef {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Offset of names[0] (months start at 1). */
  nameBase?: number;
}

const FIELDS: FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  // 7 is accepted as Sunday too.
  { name: 'day of week', min: 0, max: 7, names: WEEKDAY_NAMES, nameBase: 0 },
];

function parseValue(raw: string, def: FieldDef): number {
  const lower = raw.toLowerCase();
  const named = def.names?.indexOf(lower) ?? -1;
  if (named >= 0) return named + (def.nameBase ?? 0);
  if (!/^\d+$/.test(raw)) throw new CronError(`invalid ${def.name} "${raw}"`);
  const value = Number(raw);
  if (value < def.min || value > def.max) throw new CronError(`${def.name} ${value} is out of range ${def.min}-${def.max}`);
  return value;
}

function parseField(field: string, def: FieldDef): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const match = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new CronError(`invalid ${def.name} "${part}"`);
    const [, range, stepRaw] = match;
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (step < 1) throw new CronError(`invalid step in ${def.name} "${part}"`);
    let from: number;
    let to: number;
    if (range === '*') {
      from = def.min;
      to = def.max === 7 ? 6 : def.max;
    } else if (range!.includes('-')) {
      const [a, b, ...rest] = range!.split('-');
      if (rest.length || !a || !b) throw new CronError(`invalid range in ${def.name} "${part}"`);
      from = parseValue(a, def);
      to = parseValue(b, def);
      if (from > to) throw new CronError(`invalid range in ${def.name} "${part}"`);
    } else {
      from = parseValue(range!, def);
      // "5/15" means "from 5 to the end, every 15".
      to = stepRaw === undefined ? from : def.max === 7 ? 6 : def.max;
    }
    for (let v = from; v <= to; v += step) values.add(def.max === 7 && v === 7 ? 0 : v);
  }
  return values;
}

/** Parses a cron expression; throws CronError with a readable message. */
export function parseCron(expression: string): CronSpec {
  const trimmed = expression.trim().replace(/\s+/g, ' ');
  const source = MACROS[trimmed.toLowerCase()] ?? trimmed;
  if (source.startsWith('@')) throw new CronError(`unknown macro "${trimmed}"`);
  const fields = source.split(' ');
  if (fields.length !== 5) throw new CronError(`expected 5 fields (minute hour day month weekday), got ${fields.length}`);
  const [minutes, hours, days, months, weekdays] = fields.map((f, i) => parseField(f, FIELDS[i]!));
  return {
    minutes: minutes!,
    hours: hours!,
    days: days!,
    months: months!,
    weekdays: weekdays!,
    daysRestricted: fields[2] !== '*' && !fields[2]!.startsWith('*/'),
    weekdaysRestricted: fields[4] !== '*' && !fields[4]!.startsWith('*/'),
  };
}

/** Error message of an invalid expression, or undefined if it is valid. */
export function cronError(expression: string): string | undefined {
  try {
    parseCron(expression);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock time of an instant in a time zone, encoded as UTC milliseconds (minute precision). */
function wallClock(instant: number, timeZone: string | undefined): number {
  const key = timeZone ?? '';
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(key, fmt);
  }
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(instant))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!);
}

/** The instant at which the wall clock in the time zone shows `wall` (first one if it occurs twice). */
function toInstant(wall: number, timeZone: string | undefined): number {
  let instant = wall - (wallClock(wall, timeZone) - wall);
  instant = wall - (wallClock(instant, timeZone) - instant);
  return instant;
}

function dayMatches(spec: CronSpec, day: number, weekday: number): boolean {
  if (spec.daysRestricted && spec.weekdaysRestricted) return spec.days.has(day) || spec.weekdays.has(weekday);
  return spec.days.has(day) && spec.weekdays.has(weekday);
}

/** The first time after `after` (exclusive) that matches the expression, or undefined if there is none within 5 years. */
export function nextCronRun(expression: string | CronSpec, after: Date, timeZone?: string): Date | undefined {
  const spec = typeof expression === 'string' ? parseCron(expression) : expression;
  const start = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  let cur = wallClock(start, timeZone);
  const limit = cur + 5 * 366 * 86_400_000;
  while (cur <= limit) {
    const d = new Date(cur);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    const day = d.getUTCDate();
    const hour = d.getUTCHours();
    if (!spec.months.has(month + 1)) {
      cur = Date.UTC(year, month + 1, 1);
      continue;
    }
    if (!dayMatches(spec, day, d.getUTCDay())) {
      cur = Date.UTC(year, month, day + 1);
      continue;
    }
    if (!spec.hours.has(hour)) {
      cur = Date.UTC(year, month, day, hour + 1);
      continue;
    }
    if (!spec.minutes.has(d.getUTCMinutes())) {
      cur += 60_000;
      continue;
    }
    const instant = toInstant(cur, timeZone);
    // Times skipped by a daylight-saving jump do not exist and are left out.
    if (instant > after.getTime() && wallClock(instant, timeZone) === cur) return new Date(instant);
    cur += 60_000;
  }
  return undefined;
}

/** The next `count` run times after `after`. */
export function nextCronRuns(expression: string, after: Date, count: number, timeZone?: string): Date[] {
  const spec = parseCron(expression);
  const runs: Date[] = [];
  let from = after;
  while (runs.length < count) {
    const next = nextCronRun(spec, from, timeZone);
    if (!next) break;
    runs.push(next);
    from = next;
  }
  return runs;
}
