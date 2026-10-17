"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  getAuthSnapshot,
  getServerAuthSnapshot,
  subscribeAuth,
  writeStoredSession,
  type PosRole,
  type PosSession,
} from "@/lib/auth";

import { AuthContext, type AuthContextValue } from "@/hooks/use-auth";

/**
 * Holds the signed-in cashier for the whole client tree.
 *
 * The session lives in `localStorage` (not memory) so a refresh — or a crash
 * and relaunch on a disconnected till — does not sign anyone out. This provider
 * is only the React view of that; `lib/auth.ts` owns the storage *and* the
 * subscription, so there is no local copy of the session to fall out of step
 * with it, and no mount effect to reconcile the two.
 *
 * `signIn`/`signOut` therefore do exactly one thing — write storage — and the
 * re-render follows from the store notifying. That also means a sign-out in one
 * tab updates the other tab's UI through the `storage` event, with no extra
 * code here.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const snapshot = useSyncExternalStore(
    subscribeAuth,
    getAuthSnapshot,
    getServerAuthSnapshot,
  );

  const session = snapshot.session;

  const signIn = useCallback((next: PosSession) => {
    writeStoredSession(next);
  }, []);

  const signOut = useCallback(() => {
    writeStoredSession(null);
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const hasRole = (role: PosRole) => session?.role === role;
    return {
      session,
      // Not-yet-read is a distinct state, not an empty one: the guards must
      // wait rather than bounce a signed-in cashier to the login screen.
      status: snapshot.hydrated ? "ready" : "loading",
      isAuthenticated: session !== null,
      isManager: hasRole("manager"),
      hasRole,
      signIn,
      signOut,
    };
  }, [session, snapshot.hydrated, signIn, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
