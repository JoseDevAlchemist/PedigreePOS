"use client";

import { useEffect, useRef, useState } from "react";
import { Delete, Loader2, ShieldCheck } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import {
  createSession,
  isValidPinFormat,
  normalizePin,
  PIN_MAX_LENGTH,
  verifyPin,
} from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fetchPosUsers } from "@/lib/sync";

/**
 * PIN sign-in.
 *
 * The PIN is checked against the roster cached in IndexedDB, which is what lets
 * a cashier start a shift with no connection. The roster is refreshed from
 * Supabase on mount when there is one, but a failure is silent — being unable
 * to reach the network must not stand between a cashier and the till.
 */

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;
/** Mirrors `PIN_MIN_LENGTH`/`PIN_MAX_LENGTH` in lib/auth.ts for the message. */
const PIN_HINT = "4 to 6 digits";

type Roster = "checking" | "ready" | "empty";

export function PinLogin() {
  const { status, isAuthenticated, signIn } = useAuth();

  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [roster, setRoster] = useState<Roster>("checking");
  /** True while pulling the staff roster from Supabase into the local DB. */
  const [loading, setLoading] = useState(true);
  /** Bumped by "Try again" to re-run the roster effect. */
  const [rosterToken, setRosterToken] = useState(0);
  // Failures and lockout live together on purpose: the count only means
  // anything as "failures since the last lockout", so keeping them in one
  // object removes the need to reset two states in step — and with them, the
  // effect that used to watch the clock and clear them.
  const [gate, setGate] = useState<{ failures: number; lockedUntil: number }>({
    failures: 0,
    lockedUntil: 0,
  });
  // Starts at 0 and is filled in by the countdown below. Reading `Date.now()`
  // during render would bake the prerender's timestamp into the static HTML,
  // which the build refuses — and which would be wrong anyway.
  const [now, setNow] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);

  const locked = gate.lockedUntil > now;

  // Once auth has resolved, a signed-in user has no business on this screen.
  useEffect(() => {
    if (status === "ready" && isAuthenticated) {
      window.location.replace("/pos");
    }
  }, [status, isAuthenticated]);

  // The roster is read during the effect rather than through a helper defined
  // outside it, so that the only state written is written after an `await`, and
  // there is one thing to cancel: the flag. `rosterToken` re-runs it — the same
  // mechanism a retry button needs, and a reason not to mutate state to do it.
  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    void (async () => {
      try {
        await fetchPosUsers();
      } catch {
        // Offline, or Supabase is unreachable. The cached roster is the
        // fallback, and caching it is the entire point in the first place.
      }

      const count = await getDb()
        .pos_users.filter((user) => user.active)
        .count();

      if (cancelled) return;
      setLoading(false);
      setRoster(count > 0 ? "ready" : "empty");
    })();

    return () => {
      cancelled = true;
    };
  }, [rosterToken]);

  // Keep the hidden input focused so a physical keyboard just works.
  useEffect(() => {
    if (roster === "ready") inputRef.current?.focus();
  }, [roster]);

  // Tick only while a lockout is running, and clear the interval from inside
  // the callback once it has run out — otherwise the till would sit redrawing
  // every 250ms for the rest of the shift.
  useEffect(() => {
    const until = gate.lockedUntil;
    if (until === 0) return;

    const id = window.setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (at >= until) window.clearInterval(id);
    }, 250);

    return () => window.clearInterval(id);
  }, [gate.lockedUntil]);

  async function submit(candidate: string) {
    if (checking || locked) return;

    if (!isValidPinFormat(candidate)) {
      setError(`Enter ${PIN_HINT}.`);
      return;
    }

    setChecking(true);
    setError(null);

    try {
      const users = await getDb()
        .pos_users.filter((user) => user.active)
        .toArray();

      // The PIN is the only thing the cashier typed, so the PIN is what
      // identifies them. Compare until one matches.
      let matched: (typeof users)[number] | null = null;
      for (const user of users) {
        if (await verifyPin(candidate, user.pinHash)) {
          matched = user;
          break;
        }
      }

      if (matched === null) {
        const failures = gate.failures + 1;
        setPin("");

        if (failures >= MAX_ATTEMPTS) {
          setGate({ failures: 0, lockedUntil: Date.now() + LOCKOUT_MS });
          setNow(Date.now());
          setError("Too many attempts. Try again in 30 seconds.");
        } else {
          setGate({ failures, lockedUntil: 0 });
          const left = MAX_ATTEMPTS - failures;
          setError(
            `That PIN did not match. ${left} ${left === 1 ? "try" : "tries"} left.`,
          );
        }
        return;
      }

      signIn(
        createSession({ id: matched.id, name: matched.name, role: matched.role }),
      );
      // Hard navigation on purpose: a document request for /pos is served from
      // the service worker cache, so this works with no network at all.
      window.location.replace("/pos");
    } finally {
      setChecking(false);
    }
  }

  function press(digit: string) {
    if (locked || checking) return;
    setError(null);
    setPin((current) => normalizePin(current + digit).slice(0, PIN_MAX_LENGTH));
    inputRef.current?.focus();
  }

  function backspace() {
    if (locked || checking) return;
    setError(null);
    setPin((current) => current.slice(0, -1));
    inputRef.current?.focus();
  }

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex flex-col items-center gap-3"
      >
        <Loader2 aria-hidden="true" className="size-6 animate-spin text-muted" />
        <p className="text-sm text-muted">Syncing…</p>
      </div>
    );
  }

  if (roster === "empty") {
    return (
      <NoRoster
        onRetry={() => {
          setLoading(true);
          setRoster("checking");
          setRosterToken((token) => token + 1);
        }}
      />
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(pin);
      }}
      className="w-full max-w-sm"
    >
      <header className="text-center">
        <h1 className="font-serif text-3xl font-semibold tracking-tight text-foreground">
          Enter your PIN
        </h1>
        <p className="mt-2 text-sm text-muted">
          Staff sign in on this device. No connection needed.
        </p>
      </header>

      <div className="mt-8">
        {/* The real control, rendered invisible so the dots below can be the
            visual while a physical keyboard and a password manager both keep
            working through the native input. */}
        <label htmlFor="pos-pin" className="sr-only">
          PIN
        </label>
        <input
          id="pos-pin"
          ref={inputRef}
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={PIN_MAX_LENGTH}
          value={pin}
          disabled={locked}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? "pos-pin-error" : undefined}
          onChange={(event) => {
            setError(null);
            setPin(normalizePin(event.target.value).slice(0, PIN_MAX_LENGTH));
          }}
          className="sr-only"
        />

        <div
          aria-hidden="true"
          onClick={() => inputRef.current?.focus()}
          className="flex cursor-text justify-center gap-3"
        >
          {Array.from({ length: PIN_MAX_LENGTH }).map((_, index) => {
            const filled = index < pin.length;
            return (
              <span
                key={index}
                className={`size-4 rounded-full border transition-all duration-150 ${
                  filled
                    ? "scale-110 border-primary bg-primary"
                    : "border-border bg-well"
                }`}
              />
            );
          })}
        </div>

        <div className="mt-3 min-h-6 text-center">
          {locked ? (
            <p role="alert" className="text-sm font-medium text-danger">
              Locked — {Math.ceil((gate.lockedUntil - now) / 1000)}s
            </p>
          ) : error !== null ? (
            <p
              id="pos-pin-error"
              role="alert"
              className="text-sm font-medium text-danger"
            >
              {error}
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
          <KeypadButton key={digit} onClick={() => press(digit)} disabled={locked}>
            {digit}
          </KeypadButton>
        ))}
        <KeypadButton
          onClick={backspace}
          disabled={locked}
          aria-label="Delete last digit"
        >
          <Delete aria-hidden="true" className="mx-auto size-5" />
        </KeypadButton>
        <KeypadButton onClick={() => press("0")} disabled={locked}>
          0
        </KeypadButton>
        <button
          type="submit"
          disabled={locked || checking || pin.length === 0}
          className="flex h-16 items-center justify-center rounded-2xl bg-primary text-cream transition-colors hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {checking ? (
            <Loader2 aria-hidden="true" className="size-6 animate-spin" />
          ) : (
            <ShieldCheck aria-hidden="true" className="size-6" />
          )}
          <span className="sr-only">Sign in</span>
        </button>
      </div>
    </form>
  );
}

function KeypadButton({
  children,
  onClick,
  disabled,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="h-16 rounded-2xl border border-border bg-card text-2xl font-semibold text-foreground shadow-card transition-[transform,background-color,border-color] duration-150 hover:border-primary/40 hover:bg-well focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function NoRoster({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="w-full max-w-sm text-center">
      <h1 className="font-serif text-2xl font-semibold text-foreground">
        No staff on this device yet
      </h1>
      <p className="mt-3 text-sm leading-6 text-muted">
        This till has never reached the server, so it has no PINs to check
        against. Connect to the internet once — after that, sign-in works
        offline.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 h-11 rounded-xl bg-primary px-6 text-sm font-semibold text-cream transition-colors hover:bg-primary-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Try again
      </button>
    </div>
  );
}
