"use client";

import { WifiOff } from "lucide-react";

/**
 * Offline fallback body. It is a client component only so it can offer a
 * "try again" affordance without a server round trip — the whole point is that
 * there is no server to reach.
 */
export function OfflineShell() {
  return (
    <main className="flex min-h-full flex-1 items-center justify-center bg-background px-6 py-16">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-card">
        <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <WifiOff className="size-7" aria-hidden="true" />
        </div>
        <h1 className="mt-5 font-serif text-2xl font-semibold text-foreground">
          You&rsquo;re offline
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted">
          This screen isn&rsquo;t available offline yet. Sales you&rsquo;ve
          already made are saved on this device and will sync automatically when
          the connection returns.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-6 inline-flex h-11 items-center justify-center rounded-xl bg-primary px-6 text-sm font-semibold text-cream transition-colors hover:bg-primary-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
