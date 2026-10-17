"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, Loader2, ShieldCheck, UserPlus, Users } from "lucide-react";

import { AppHeader } from "@/components/app-header";
import { ManagerNav } from "@/components/manager/manager-nav";
import { SyncProvider } from "@/components/sync-provider";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, normalizePin } from "@/lib/auth";
import { getDb, type LocalPosUser } from "@/lib/db";
import { createCashier } from "@/lib/staff";

/**
 * Staff management.
 *
 * One job, deliberately: enrol a cashier. The PIN is hashed in the browser with
 * the same settings the sign-in screen checks against, and only the hash is
 * sent, so a plaintext PIN never leaves the counter.
 *
 * The roster is read from the local database, which is what the till actually
 * signs people in from. Enrolling refreshes it, so a new cashier can walk up and
 * sign in without waiting for the next sync.
 *
 * Deactivating and re-pinning are not here yet: the app's key has no UPDATE
 * policy on `pos_users`, and a half-built editor that silently fails would be
 * worse than its absence.
 */
export function StaffManager() {
  const cashiers = useLiveQuery(
    () => getDb().pos_users.where("role").equals("cashier").sortBy("name"),
    [],
    [] as LocalPosUser[],
  );

  return (
    <>
      <SyncProvider />
      <AppHeader current="manager" />

      <main className="mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-6 px-4 py-6 lg:px-8">
        <header>
          <h1 className="font-serif text-3xl font-semibold tracking-tight text-foreground">
            Staff
          </h1>
          <p className="mt-1 text-sm text-muted">
            Cashiers who can sign in on this till. Managers are seeded on the
            server.
          </p>
        </header>

        <ManagerNav current="staff" />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
          <NewCashierForm />

          <section
            aria-label="Cashiers"
            className="overflow-hidden rounded-3xl border border-border bg-card shadow-card"
          >
            <header className="flex items-center gap-2 border-b border-border px-5 py-4">
              <Users aria-hidden="true" className="size-4 text-primary" />
              <h2 className="font-serif text-lg font-semibold tracking-tight text-foreground">
                Cashiers
              </h2>
              <span className="rounded-full bg-well px-2 py-0.5 text-xs font-semibold text-muted tabular-nums">
                {cashiers.length}
              </span>
            </header>

            {cashiers.length === 0 ? (
              <p className="px-5 py-12 text-center text-sm text-muted">
                No cashiers on this device yet. Add one to the left, or connect
                so the roster can sync.
              </p>
            ) : (
              <ul className="divide-y divide-border/60">
                {cashiers.map((cashier) => (
                  <li
                    key={cashier.id}
                    className="flex items-center gap-3 px-5 py-3.5"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-well font-serif text-base font-semibold text-primary">
                      {initials(cashier.name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">
                        {cashier.name}
                      </p>
                      <p className="text-xs text-muted">Cashier</p>
                    </div>
                    <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2.5 py-1 text-xs font-semibold text-success">
                      <Check aria-hidden="true" className="size-3.5" />
                      Active
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </>
  );
}

function NewCashierForm() {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    setAdded(null);
    try {
      await createCashier({ name, pin });
      setAdded(name.trim());
      setName("");
      setPin("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not add the cashier.",
      );
    } finally {
      setSaving(false);
    }
  }

  const canSubmit =
    !saving && name.trim().length >= 2 && pin.length >= PIN_MIN_LENGTH;

  return (
    <section
      aria-label="Add a cashier"
      className="flex h-fit flex-col gap-5 rounded-3xl border border-border bg-card p-5 shadow-card"
    >
      <header className="flex items-center gap-2">
        <UserPlus aria-hidden="true" className="size-4 text-primary" />
        <h2 className="font-serif text-lg font-semibold tracking-tight text-foreground">
          Add a cashier
        </h2>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          void submit();
        }}
        className="flex flex-col gap-5"
      >
        <div>
          <label htmlFor="cashier-name" className="text-sm font-semibold text-foreground">
            Full name
          </label>
          <input
            id="cashier-name"
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Brian Otieno"
            className="mt-2 h-12 w-full rounded-xl border border-border bg-card px-4 text-sm text-foreground transition-colors outline-none placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
        </div>

        <div>
          <label htmlFor="cashier-pin" className="text-sm font-semibold text-foreground">
            PIN
          </label>
          <input
            id="cashier-pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={PIN_MAX_LENGTH}
            value={pin}
            onChange={(event) =>
              setPin(normalizePin(event.target.value).slice(0, PIN_MAX_LENGTH))
            }
            placeholder="••••"
            className="mt-2 h-12 w-full rounded-xl border border-border bg-card px-4 font-mono text-lg tracking-[0.3em] text-foreground transition-colors outline-none placeholder:text-muted/40 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
          <p className="mt-2 text-xs leading-5 text-muted">
            {PIN_MIN_LENGTH}–{PIN_MAX_LENGTH} digits. It is hashed before it
            leaves this device, and must be unique across staff.
          </p>
        </div>

        {error !== null ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        {added !== null ? (
          <p
            role="status"
            className="inline-flex items-center gap-1.5 rounded-xl bg-success-soft px-3 py-2 text-sm font-semibold text-success"
          >
            <Check aria-hidden="true" className="size-4" />
            {added} can now sign in on this till.
          </p>
        ) : null}

        <button
          type="submit"
          disabled={!canSubmit}
          className="flex h-12 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-cream transition-colors hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {saving ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <ShieldCheck aria-hidden="true" className="size-4" />
          )}
          Create cashier
        </button>

        <p className="text-xs leading-5 text-muted">
          Adding staff needs a connection: the account has to exist on the
          server before it can be used on any till.
        </p>
      </form>
    </section>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part.charAt(0).toUpperCase()).join("") || "?";
}
