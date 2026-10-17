"use client";

import { useEffect } from "react";

import { BrandMark } from "@/components/brand-mark";
import { useAuth } from "@/hooks/use-auth";
import type { PosRole } from "@/lib/auth";

/**
 * The offline-proof route guard.
 *
 * Deliberately a client component rather than middleware. Middleware runs on
 * the server on every request, so a till with no connection would never reach
 * it — the check would fail exactly when the shop most needs the app to work.
 * Reading `localStorage` in the browser is the only version of this that keeps
 * working in airplane mode.
 *
 * The redirect uses `window.location`, not the router. A client-side navigation
 * needs an RSC payload from the server; a document request for a precached
 * route is served by the service worker with no network at all. Guarding is the
 * one place where a hard navigation is the correct call.
 */
export function RequireAuth({
  children,
  role,
}: {
  children: React.ReactNode;
  /** When set, the signed-in user must hold this role. */
  role?: PosRole;
}) {
  const { status, isAuthenticated, hasRole } = useAuth();

  const permitted = isAuthenticated && (role === undefined || hasRole(role));

  useEffect(() => {
    if (status !== "ready") return;
    if (!isAuthenticated) {
      window.location.replace("/login");
      return;
    }
    if (role !== undefined && !hasRole(role)) {
      // Signed in, wrong role. The till is home, so send them there.
      window.location.replace("/pos");
    }
  }, [status, isAuthenticated, role, hasRole]);

  // Nothing is rendered until `localStorage` has been read. Flashing the login
  // screen at a signed-in cashier on every reload would be a bug, not a state.
  if (status !== "ready" || !permitted) {
    return <AuthGateSplash />;
  }

  return <>{children}</>;
}

/**
 * What shows while auth resolves, and while a redirect is in flight. Static and
 * self-contained: it is on screen at the moment the app is least certain of
 * anything, so it must not depend on data.
 */
function AuthGateSplash() {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center bg-background">
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col items-center gap-4"
      >
        <span className="motion-safe:animate-pulse">
          <BrandMark size={64} tagline />
        </span>
        <span className="text-sm text-muted">Signing you in…</span>
      </div>
    </main>
  );
}
