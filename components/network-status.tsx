"use client";

import { AlertTriangle, Check, RefreshCw, WifiOff } from "lucide-react";

import { useSyncState } from "@/hooks/use-sync-state";
import { runSync } from "@/lib/sync";

/**
 * The till's connection light.
 *
 * One glance has to answer the only question that matters at a counter: *is my
 * money safe?* So the states say exactly that and nothing else —
 *
 *   green   the server has everything (or there is nothing to send)
 *   amber   something is waiting; it is stored, it has not been sent
 *   red     no connection, or a sale the server refused
 *
 * Amber is deliberately not red. Work sitting in the queue is the normal,
 * designed-for case, not an error, and colouring it like one would train
 * cashiers to ignore red. Red is reserved for money that has not landed: a
 * catalogue that would not refresh or a receipt that would not email is worth
 * a note — amber, with the detail in the tooltip — but it is not the same
 * thing as a sale that did not sync, and it must not look like it.
 */

type Tone = "neutral" | "success" | "warning" | "danger";

interface Presentation {
  tone: Tone;
  label: string;
  detail: string;
  icon: typeof Check;
  busy?: boolean;
}

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "border-border bg-well text-muted",
  success: "border-success/30 bg-success-soft text-success",
  warning: "border-accent/50 bg-accent/15 text-primary-deep",
  danger: "border-danger/30 bg-danger-soft text-danger",
};

const DOT_CLASSES: Record<Tone, string> = {
  neutral: "bg-muted",
  success: "bg-success",
  warning: "bg-accent",
  danger: "bg-danger",
};

function describe(state: ReturnType<typeof useSyncState>): Presentation {
  if (!state.hydrated) {
    return {
      tone: "neutral",
      label: "Checking connection",
      detail: "Reading the device's network state…",
      icon: RefreshCw,
      busy: true,
    };
  }

  if (!state.configured) {
    return {
      tone: "warning",
      label: "Offline only",
      detail:
        "No Supabase credentials are configured, so sales stay on this device.",
      icon: WifiOff,
    };
  }

  if (!state.online) {
    const waiting =
      state.pending > 0
        ? `${state.pending} saved locally, waiting to send`
        : "Saved locally";
    return {
      tone: "danger",
      label: "Offline",
      detail: waiting,
      icon: WifiOff,
    };
  }

  if (state.syncing) {
    return {
      tone: "warning",
      label: "Syncing",
      detail: "Sending saved sales…",
      icon: RefreshCw,
      busy: true,
    };
  }

  if (state.pending > 0) {
    return {
      tone: "warning",
      label: `${state.pending} waiting`,
      detail:
        state.lastError ??
        state.lastNotice ??
        "Stored safely on this device, not sent yet.",
      icon: RefreshCw,
    };
  }

  // Money first. A sale the server refused is the only thing worth a red light
  // while the till is online.
  if (state.lastError !== null) {
    return {
      tone: "danger",
      label: "Sync issue",
      detail: state.lastError,
      icon: AlertTriangle,
    };
  }

  // Amber, not red: everything that matters has synced, but something on the
  // side (a stale catalogue, an undelivered receipt) wants a manager's eye. The
  // detail carries it; the pill stays a glance.
  if (state.lastNotice !== null) {
    return {
      tone: "warning",
      label: "Synced, with notes",
      detail: state.lastNotice,
      icon: AlertTriangle,
    };
  }

  return {
    tone: "success",
    label: "Online",
    detail: "Everything is synced.",
    icon: Check,
  };
}

export function NetworkStatus({ onSync }: { onSync?: () => void }) {
  const state = useSyncState();
  const presentation = describe(state);
  const Icon = presentation.icon;

  return (
    <div className="flex items-center gap-2">
      <span
        // `polite` rather than `assertive`: losing the connection should not
        // interrupt a screen reader mid-sentence while a sale is being rung up.
        role="status"
        aria-live="polite"
        title={presentation.detail}
        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${TONE_CLASSES[presentation.tone]}`}
      >
        <span className="relative flex size-2">
          <span
            className={`size-2 rounded-full ${DOT_CLASSES[presentation.tone]}`}
          />
          {presentation.busy ? (
            <span
              aria-hidden="true"
              className={`absolute inset-0 rounded-full ${DOT_CLASSES[presentation.tone]} motion-safe:animate-ping`}
            />
          ) : null}
        </span>
        <Icon aria-hidden="true" className="size-3.5" />
        <span>{presentation.label}</span>
      </span>

      <button
        type="button"
        onClick={() => {
          if (onSync) onSync();
          else void runSync().catch(() => {});
        }}
        disabled={state.syncing || !state.configured}
        className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:border-primary/40 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Force Sync Now
      </button>
    </div>
  );
}
