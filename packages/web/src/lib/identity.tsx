import { createContext, useContext, type ReactNode } from 'react';
import type { Identity } from '@cocoon/protocol';
import { rpc } from '../api/rpc';
import { clearToken, getToken } from './auth';

const IdentityContext = createContext<Identity | null>(null);

export function IdentityProvider({ identity, children }: { identity: Identity; children: ReactNode }) {
  return <IdentityContext.Provider value={identity}>{children}</IdentityContext.Provider>;
}

/**
 * Who is signed in. The UI hides what a member cannot use, but that is only convenience: the server decides on every call.
 */
export function useIdentity(): { identity: Identity; isAdmin: boolean } {
  const identity = useContext(IdentityContext);
  if (!identity) throw new Error('useIdentity needs an IdentityProvider');
  return { identity, isAdmin: identity.role === 'admin' };
}

/** Display name of a signed-in user; `fallback` for tokens, which have no account. */
export function identityName(identity: Identity, fallback: string): string {
  return identity.user?.displayName || identity.user?.username || fallback;
}

/**
 * Signs out of this browser at once, then ends the session on the server (`everywhere`: every session of the user).
 * An API or admin token is only forgotten here; it keeps working elsewhere until it is revoked.
 */
export function useSignOut() {
  const { identity } = useIdentity();
  return (everywhere = false) => {
    const token = getToken();
    clearToken();
    if (identity.kind === 'user') void rpc('auth.logout', { everywhere }, token).catch(() => undefined);
  };
}
