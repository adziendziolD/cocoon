import { readFileSync } from 'node:fs';

/** CoCoon's version (from the root package.json, so it changes with an update). */
export const VERSION = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/** When this server process started. */
export const STARTED_AT = new Date().toISOString();
