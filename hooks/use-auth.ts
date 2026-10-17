"use client";

import { createContext, useContext } from "react";

import type { PosRole, PosSession } from "@/lib/auth";

export interface AuthContextValue {
  /** The signed-in user, or null. */
  session: PosSession | null;
  /**
   * `"loading"` until `localStorage` has been read on the client. Route guards
   * must not redirect while loading: on the server — and on the first client
   * render — `session` is always null, and acting on that would bounce a signed
   * in cashier to the login screen on every reload.
   */
  status: "loading" | "ready";
  isAuthenticated: boolean;
  isManager: boolean;
  hasRole: (role: PosRole) => boolean;
  signIn: (session: PosSession) => void;
  signOut: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error("useAuth must be used inside <AuthProvider>.");
  }
  return context;
}
