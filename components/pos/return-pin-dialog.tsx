"use client";

import { useEffect, useRef, useState } from "react";
import { Delete, Loader2, ShieldCheck } from "lucide-react";

import { Modal } from "@/components/ui/modal";
import { PIN_MAX_LENGTH, normalizePin, verifyPin } from "@/lib/auth";
import { getDb } from "@/lib/db";

/**
 * Manager approval for a return.
 *
 * The cashier cannot process a return alone. This dialog asks for a manager's
 * PIN and only approves it when the PIN matches an active user whose role is
 * `manager`, using the same `verifyPin` path as sign-in.
 */

type Roster = "checking" | "ready" | "empty";

interface ReturnPinDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the approving manager's session once the PIN is verified. */
  onApprove: (manager: { id: string; name: string }) => void;
}

export function ReturnPinDialog({
  open,
  onClose,
  onApprove,
}: ReturnPinDialogProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [roster, setRoster] = useState<Roster>("checking");
  const [gate, setGate] = useState<{ failures: number; lockedUntil: number }>({
    failures: 0,
    lockedUntil: 0,
  });
  const [now, setNow] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const locked = gate.lockedUntil > now;

  const MAX_ATTEMPTS = 5;
  const LOCKOUT_MS = 30_000;

  // Load the roster of active managers so a PIN can be checked offline.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await getDb()
          .pos_users.filter((user) => user.active && user.role === "manager")
          .toArray();
        if (!cancelled) setRoster(data.length > 0 ? "ready" : "empty");
      } catch {
        if (!cancelled) setRoster("empty");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (roster === "ready") inputRef.current?.focus();
  }, [roster]);

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

  async function submit() {
    if (checking || locked || pin.length !== PIN_MAX_LENGTH) return;
    setChecking(true);
    setError(null);

    try {
      const users = await getDb()
        .pos_users.filter((user) => user.active && user.role === "manager")
        .toArray();

      let matched: (typeof users)[number] | null = null;
      for (const user of users) {
        if (await verifyPin(pin, user.pinHash)) {
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

      onApprove({ id: matched.id, name: matched.name });
    } finally {
      setChecking(false);
    }
  }

  function press(digit: string) {
    if (locked || checking) return;
    setError(null);
    setPin(normalizePin(pin + digit).slice(0, PIN_MAX_LENGTH));
    inputRef.current?.focus();
  }

  function backspace() {
    if (locked || checking) return;
    setError(null);
    setPin((current) => current.slice(0, -1));
    inputRef.current?.focus();
  }

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Manager approval"
      description="A return needs a manager's PIN before stock can go back up."
      size="md"
      dismissible
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="w-full max-w-sm flex flex-col items-center"
      >
        <div className="mt-8 flex flex-col items-center w-full">
          <label htmlFor="return-pin" className="sr-only">
            Manager PIN
          </label>
          <input
            id="return-pin"
            ref={inputRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={PIN_MAX_LENGTH}
            value={pin}
            disabled={locked}
            aria-invalid={error !== null}
            aria-describedby={error !== null ? "return-pin-error" : undefined}
            onChange={(event) => {
              setError(null);
              setPin(normalizePin(event.target.value).slice(0, PIN_MAX_LENGTH));
            }}
            className="sr-only"
          />

          <div
            aria-hidden="true"
            onClick={() => inputRef.current?.focus()}
            className="mt-2 flex cursor-text justify-center gap-3"
          >
            {Array.from({ length: PIN_MAX_LENGTH }).map((_, index) => {
              const filled = index < pin.length;
              return (
                <span
                  key={index}
                  className={`size-4 rounded-full border transition-all duration-150 ${filled
                    ? "scale-110 border-primary bg-primary"
                    : "border-border bg-well"
                    }`}
                />
              );
            })}
          </div>

          <div className="mt-4 min-h-6 w-full text-center">
            {locked ? (
              <p role="alert" className="text-sm font-medium text-danger">
                Locked — {Math.ceil((gate.lockedUntil - now) / 1000)}s
              </p>
            ) : error !== null ? (
              <p
                id="return-pin-error"
                role="alert"
                className="text-sm font-medium text-danger"
              >
                {error}
              </p>
            ) : null}
          </div>
        </div>

        <div className="mt-8 grid grid-cols-3 gap-4 w-full max-w-xs">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
            <ReturnKeypadButton
              key={digit}
              onClick={() => press(digit)}
              disabled={locked}
            >
              {digit}
            </ReturnKeypadButton>
          ))}
          <ReturnKeypadButton onClick={backspace} disabled={locked} aria-label="Delete last digit">
            <Delete aria-hidden="true" className="mx-auto size-5" />
          </ReturnKeypadButton>
          <ReturnKeypadButton onClick={() => press("0")} disabled={locked}>
            0
          </ReturnKeypadButton>
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
            <span className="sr-only">Approve</span>
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ReturnKeypadButton({
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
      className="h-16 rounded-2xl border border-border bg-card text-2xl font-semibold text-foreground shadow-card transition-[transform,background-color,border-color] duration-150 hover:bg-primary/10 hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
