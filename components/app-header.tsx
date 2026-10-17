"use client";

import { useEffect, useState } from "react";
import { LogOut } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { NetworkStatus } from "@/components/network-status";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";

/**
 * The till's chrome.
 *
 * Navigation uses plain anchors, not `next/link`. A client-side navigation needs
 * an RSC payload from the server, and the one thing this app must do is move
 * between two screens while the router's cache is all there is. A document
 * request for a precached route is answered by the service worker, offline,
 * every time.
 */
export function AppHeader({ current }: { current: "pos" | "manager" }) {
  const { session, isManager, signOut } = useAuth();

  const links = [
    { href: "/pos", label: "Till", key: "pos" as const },
    ...(isManager
      ? [{ href: "/manager", label: "Manager", key: "manager" as const }]
      : []),
  ];

  return (
    <header className="no-print sticky top-0 z-30 border-b border-border bg-card/95 shadow-bar backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-[1800px] items-center gap-6 px-4 lg:px-8">
        <a
          href="/pos"
          className="flex shrink-0 items-center rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
        >
          <BrandMark size={36} />
        </a>

        <nav aria-label="Sections" className="flex items-center gap-1">
          {links.map((link) => {
            const active = link.key === current;
            return (
              <a
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative rounded-xl px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                  active
                    ? "text-primary"
                    : "text-muted hover:bg-well hover:text-foreground",
                )}
              >
                {link.label}
                {/* A saddle stitch under the active section, borrowed from the
                    leather it is named after. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    "stitch absolute inset-x-3 -bottom-px h-px",
                    active ? "text-accent" : "text-transparent",
                  )}
                />
              </a>
            );
          })}
        </nav>

        <div className="ms-auto flex items-center gap-3">
          <TillClock />
          <NetworkStatus />

          {session !== null ? (
            <div className="flex items-center gap-3 border-s border-border ps-3">
              <span className="hidden flex-col leading-tight sm:flex">
                <span className="text-sm font-semibold text-foreground">
                  {session.name}
                </span>
                <span className="text-[0.6875rem] font-semibold tracking-[0.16em] text-muted uppercase">
                  {session.role}
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  signOut();
                  window.location.replace("/login");
                }}
                className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-xs font-semibold text-muted transition-colors hover:border-danger/40 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <LogOut aria-hidden="true" className="size-3.5" />
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/**
 * The clock, for checking a receipt against a customer's phone.
 *
 * Rendered only after mount: the server and the browser would disagree about
 * the time, and a mismatch that does not exist is not worth explaining.
 */
function TillClock() {
  const [time, setTime] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => setTime(formatTime(new Date()));
    tick();
    const id = window.setInterval(tick, 20_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <span
      className="hidden text-sm font-semibold tabular-nums text-muted md:inline"
      suppressHydrationWarning
    >
      {time ?? "--:--"}
    </span>
  );
}
