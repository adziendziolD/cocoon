import type { ErrorCode } from '@cocoon/protocol';
import { t } from './i18n.ts';

export class CocoonError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CocoonError';
  }
}

export const notFound = (what: string, id: string) => new CocoonError('not_found', t('error.notFound', { what, id }));

export const httpStatus: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  timeout: 504,
  internal: 500,
};
