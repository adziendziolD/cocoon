import { randomBytes } from 'node:crypto';

/** Short, tmux- and docker-safe identifiers (no ':' or '.'). */
export const newId = (prefix: 'sb' | 'ag' | 'tk' | 'bd' | 'ws' | 'ts') => `${prefix}_${randomBytes(6).toString('hex')}`;
