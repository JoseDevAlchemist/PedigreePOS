"use client";

import { MonitorSmartphone } from "lucide-react";

import { useCustomerDisplay } from "@/hooks/use-customer-display";
import { cn } from "@/lib/cn";

/**
 * The customer-facing display connection pill.
 *
 * Lives in the till header. The Web Serial API can only be used from a user
 * gesture, so the button itself calls `connect()`; once connected the same spot
 * becomes a read-only green pill and `tryReconnect` handles later reconnects
 * after a page reload (via the stored vendor/product id).
 */
export function CustomerDisplayControl() {
  const { status, connect, tryReconnect } = useCustomerDisplay();

  const connected = status === "connected";

  return (
    <button
      type="button"
      onClick={() => {
        void (connected ? tryReconnect() : connect());
      }}
      disabled={status === "connecting"}
      aria-label={
        connected ? "Customer display connected" : "Connect customer display"
      }
      className={cn(
        "inline-flex h-10 items-center gap-2 rounded-full border px-3.5 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        connected
          ? "border-success/40 bg-success-soft text-success"
          : "border-border bg-card text-muted hover:border-primary/35 hover:text-primary",
      )}
    >
      <MonitorSmartphone aria-hidden="true" className="size-4" />
      {status === "connecting" ? (
        "Connecting…"
      ) : connected ? (
        "Display Connected"
      ) : (
        "Connect Display"
      )}
    </button>
  );
}
