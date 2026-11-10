import { z } from 'zod';

/** Password rules shared by the server and the UI (the server is authoritative, the UI only gives early feedback). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** 3 to 64 characters, lower case; the first and last one are a letter or digit. Plain ASCII, so two names never look alike. */
export const USERNAME = /^[a-z0-9][a-z0-9._@+-]{1,62}[a-z0-9]$/;
export const Username = z.string().trim().toLowerCase().regex(USERNAME);

export const UserRole = z.enum(['admin', 'member']);
export type UserRole = z.infer<typeof UserRole>;

export const DisplayName = z.string().trim().max(80);

export const UserStatus = z.enum(['active', 'invited', 'disabled']);
export type UserStatus = z.infer<typeof UserStatus>;

export const UserInfo = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().optional(),
  role: UserRole,
  /** active: can sign in. invited: no password yet, waiting for the setup link. disabled: cannot sign in. */
  status: UserStatus,
  createdAt: z.string(),
  lastLoginAt: z.string().optional(),
  passwordSetAt: z.string().optional(),
  /** Invited users: when the setup link stops working. */
  setupExpiresAt: z.string().optional(),
  /** Number of valid sessions (signed-in browsers). */
  sessions: z.number().int(),
});
export type UserInfo = z.infer<typeof UserInfo>;

/** One-time link target for choosing a password (new users and password resets). The token is shown only once. */
export const SetupLink = z.object({ token: z.string(), expiresAt: z.string() });
export type SetupLink = z.infer<typeof SetupLink>;

/** Who is calling: an API/admin token (always admin) or a signed-in user. */
export const Identity = z.object({
  kind: z.enum(['token', 'user']),
  role: UserRole,
  user: z.object({ id: z.string(), username: z.string(), displayName: z.string().optional() }).optional(),
  /** Name of the API token (kind "token"). */
  tokenName: z.string().optional(),
  /** Sessions: the latest point the session ends, however active it is. */
  sessionExpiresAt: z.string().optional(),
});
export type Identity = z.infer<typeof Identity>;

// ── Requests that need no token (POST /v1/auth/*) ───────────────────────────

export const LoginParams = z.object({
  username: z.string().trim().toLowerCase().min(1).max(128),
  password: z.string().min(1).max(1024),
});
export type LoginParams = z.infer<typeof LoginParams>;

export const SetupInfoParams = z.object({ token: z.string().min(1).max(256) });
export const SetupInfoResult = z.object({ username: z.string(), displayName: z.string().optional() });
export type SetupInfoResult = z.infer<typeof SetupInfoResult>;

export const SetupParams = z.object({
  token: z.string().min(1).max(256),
  /** The length rules are checked by the server, which answers with a readable message. */
  password: z.string().max(1024),
});
export type SetupParams = z.infer<typeof SetupParams>;

/** A new session: `token` goes into the Authorization header like an API token. */
export const SessionResult = z.object({ token: z.string(), expiresAt: z.string(), identity: Identity });
export type SessionResult = z.infer<typeof SessionResult>;
