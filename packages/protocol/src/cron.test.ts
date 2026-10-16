import { describe, expect, it } from 'vitest';
import { cronError, isValidTimeZone, nextCronRun, nextCronRuns, parseCron } from './cron.ts';
import { parseReport, Schedule } from './schedules.ts';

const iso = (d: Date | undefined) => d?.toISOString();

describe('parseCron', () => {
  it('parses lists, ranges, steps and names', () => {
    const spec = parseCron('*/15 8-18/2 1,15 jan-mar mon-fri');
    expect([...spec.minutes]).toEqual([0, 15, 30, 45]);
    expect([...spec.hours]).toEqual([8, 10, 12, 14, 16, 18]);
    expect([...spec.days]).toEqual([1, 15]);
    expect([...spec.months]).toEqual([1, 2, 3]);
    expect([...spec.weekdays]).toEqual([1, 2, 3, 4, 5]);
  });

  it('accepts 7 as Sunday, "5/20" as a start with step, and macros', () => {
    expect([...parseCron('0 0 * * 7').weekdays]).toEqual([0]);
    expect([...parseCron('5/20 * * * *').minutes]).toEqual([5, 25, 45]);
    expect([...parseCron('@daily').hours]).toEqual([0]);
    expect([...parseCron('@weekly').weekdays]).toEqual([0]);
  });

  it('rejects invalid expressions with a readable message', () => {
    expect(cronError('* * * *')).toMatch(/5 fields/);
    expect(cronError('60 * * * *')).toMatch(/out of range/);
    expect(cronError('* * * foo *')).toMatch(/invalid month/);
    expect(cronError('5-1 * * * *')).toMatch(/invalid range/);
    expect(cronError('*/0 * * * *')).toMatch(/invalid step/);
    expect(cronError('@sometimes')).toMatch(/unknown macro/);
    expect(cronError(' 0  3 * * * ')).toBeUndefined();
  });
});

describe('nextCronRun', () => {
  it('finds the next matching minute (exclusive)', () => {
    const after = new Date('2026-10-16T10:07:30Z');
    expect(iso(nextCronRun('*/15 * * * *', after, 'UTC'))).toBe('2026-10-16T10:15:00.000Z');
    expect(iso(nextCronRun('0 3 * * *', after, 'UTC'))).toBe('2026-10-17T03:00:00.000Z');
    expect(iso(nextCronRun('15 10 * * *', new Date('2026-10-16T10:15:00Z'), 'UTC'))).toBe('2026-10-17T10:15:00.000Z');
  });

  it('evaluates the expression in the time zone', () => {
    // 03:00 in Berlin is 01:00 UTC in summer (CEST) and 02:00 UTC in winter (CET).
    expect(iso(nextCronRun('0 3 * * *', new Date('2026-07-01T12:00:00Z'), 'Europe/Berlin'))).toBe('2026-07-02T01:00:00.000Z');
    expect(iso(nextCronRun('0 3 * * *', new Date('2026-12-01T12:00:00Z'), 'Europe/Berlin'))).toBe('2026-12-02T02:00:00.000Z');
    expect(iso(nextCronRun('30 9 * * 1', new Date('2026-10-16T00:00:00Z'), 'America/New_York'))).toBe('2026-10-19T13:30:00.000Z');
  });

  it('handles daylight saving time: skipped times are left out, repeated times run once', () => {
    // Berlin 2026-03-29: 02:00 → 03:00 (02:30 does not exist).
    expect(iso(nextCronRun('30 2 * * *', new Date('2026-03-28T12:00:00Z'), 'Europe/Berlin'))).toBe('2026-03-30T00:30:00.000Z');
    // Berlin 2026-10-25: 03:00 → 02:00 (02:30 happens twice) – one run that night.
    const runs = nextCronRuns('30 2 * * *', new Date('2026-10-24T12:00:00Z'), 2, 'Europe/Berlin');
    expect(runs.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-10-25', '2026-10-26']);
  });

  it('matches day of month OR day of week when both are restricted', () => {
    // 2026-11-01 is a Sunday; the 13th is a Friday.
    const runs = nextCronRuns('0 12 13 * 5', new Date('2026-11-01T00:00:00Z'), 3, 'UTC');
    expect(runs.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-11-06', '2026-11-13', '2026-11-20']);
  });

  it('weekdays and months', () => {
    const runs = nextCronRuns('0 9 * * mon-fri', new Date('2026-10-16T10:00:00Z'), 3, 'UTC');
    expect(runs.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-10-19', '2026-10-20', '2026-10-21']);
    expect(iso(nextCronRun('0 0 29 2 *', new Date('2026-10-16T00:00:00Z'), 'UTC'))).toBe('2028-02-29T00:00:00.000Z');
    expect(nextCronRun('0 0 31 2 *', new Date('2026-10-16T00:00:00Z'), 'UTC')).toBeUndefined();
  });

  it('validates time zones', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('schedules', () => {
  const base = { id: 'sc_1', workspaceId: 'ws_1', name: 'Nightly', prompt: 'Run all checks', createdAt: 'x', updatedAt: 'x' };

  it('validates cron and time zone in the schema and fills defaults', () => {
    const parsed = Schedule.parse({ ...base, cron: '0 3 * * *', timezone: 'Europe/Berlin' });
    expect(parsed).toMatchObject({ enabled: true, overlap: 'skip', autoClose: true, keepRuns: 10, template: 'custom' });
    expect(Schedule.safeParse({ ...base, cron: '0 25 * * *' }).success).toBe(false);
    expect(Schedule.safeParse({ ...base, cron: '0 3 * * *', timezone: 'Nowhere/City' }).success).toBe(false);
  });

  it('reads the report of a scheduled run', () => {
    expect(parseReport('{"status":"ok","summary":"All 4 checks passed","report":"- ✅ lint"}', 'T')).toEqual({ status: 'ok', summary: 'All 4 checks passed', details: '- ✅ lint', at: 'T' });
    expect(parseReport('```json\n{"status":"action_needed","summary":"2 tests fail"}\n```').status).toBe('action_needed');
    expect(parseReport('').status).toBe('missing');
    expect(parseReport('{"status":"great"}').status).toBe('missing');
  });
});
