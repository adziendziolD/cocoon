import type { UserRole } from '@cocoon/protocol';

/**
 * Who a request comes from. Decided once when the request arrives and then handed to the RPC layer, never read from
 * ambient state, so no code path can run a method without knowing the caller.
 */
export type Principal =
  /** An API or admin token: always an admin. */
  | { kind: 'token'; role: 'admin'; credentialId: string; name: string }
  /** A user who signed in with a password; the role is read from the account at every request. */
  | { kind: 'user'; role: UserRole; credentialId: string; userId: string; username: string; displayName?: string };

export const TOKEN_PREFIX = 'token:';
export const SESSION_PREFIX = 'session:';
