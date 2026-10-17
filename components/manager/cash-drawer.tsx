"use client";

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Check, Loader2, Lock, Unlock, Wallet } from "lucide-react";

import { Modal } from "@/components/ui/modal";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/cn";
import type { LocalTillSession } from "@/lib/db";
import { formatAmount, toWholeShillings } from "@/lib/format";
import { formatEatDateTime } from "@/lib/time";
import { closeTill, getExpectedCash, getOpenTill, getRecentTills, openTill } from "@/lib/till";

/**
 * The cash drawer, for the manager.
 *
 * Open a shift with the float in the drawer; close it against a physical count.
 * The number that matters is only visible at close — the difference between
 * what should be there and what is — so it is the largest thing on the panel
 * and is colour-coded the moment it is calculated.
 *
 * Both actions write to the device and never wait on the network: counting a
 * drawer is an offline act if ever there was one.
 */
export function CashDrawer() {
  const { session } = useAuth();
  const [dialog, setDialog] = useState<"open" | "close" | null>(null);

  const open = useLiveQuery(() => getOpenTill(), [], undefined);
  const expectedCash = useLiveQuery(
    async () => {
      const till = await getOpenTill();
      return till === null ? null : getExpectedCash(till);
    },
    [],
    undefined,
  );
  const recent = useLiveQuery(
    () => getRecentTills(3),
    [],
    [] as LocalTillSession[],
  );

  const operator = session?.name ?? "Unknown";

  return (
    <section
      aria-label="Cash drawer"
      className="flex flex-col gap-4 rounded-3xl border border-border bg-card p-5 shadow-card"
    >
      <header className="flex items-center gap-2">
        <Wallet aria-hidden="true" className="size-4 text-primary" />
        <h2 className="font-serif text-lg font-semibold tracking-tight text-foreground">
          Cash drawer
        </h2>
      </header>

      {open === undefined ? (
        <p className="text-sm text-muted">Reading the drawer…</p>
      ) : open === null ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            No shift open. Count the starting float and open the till.
          </p>
          <button
            type="button"
            onClick={() => setDialog("open")}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-cream transition-colors hover:bg-primary-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Unlock aria-hidden="true" className="size-4" />
            Open till
          </button>
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            <Figure label="Opened by" value={open.openedBy} />
            <Figure
              label="Since"
              value={formatEatDateTime(open.openedAt)}
            />
            <Figure label="Opening float" value={formatAmount(open.openingFloat)} />
            <Figure
              label="Cash expected"
              value={formatAmount(expectedCash ?? open.openingFloat)}
              emphasis
            />
          </dl>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setDialog("close")}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-semibold text-foreground transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <Lock aria-hidden="true" className="size-4" />
              Close till
            </button>
          </div>
        </>
      )}

      {recent.length > 0 ? (
        <div className="border-t border-border pt-3">
          <h3 className="text-xs font-semibold tracking-[0.14em] text-muted uppercase">
            Recent shifts
          </h3>
          <ul className="mt-2 flex flex-col gap-1.5">
            {recent.map((till) => (
              <li
                key={till.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted"
              >
                <span className="tabular-nums">
                  {formatEatDateTime(till.openedAt)} · {till.openedBy}
                </span>
                {till.variance === null ? (
                  <span className="font-semibold text-primary-deep">Open</span>
                ) : (
                  <VarianceBadge variance={till.variance} compact />
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <OpenTillDialog
        open={dialog === "open"}
        onClose={() => setDialog(null)}
        operator={operator}
      />
      <CloseTillDialog
        open={dialog === "close"}
        onClose={() => setDialog(null)}
        operator={operator}
        expectedCash={typeof expectedCash === "number" ? expectedCash : null}
        till={open ?? null}
      />
    </section>
  );
}

function Figure({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 font-semibold tabular-nums",
          emphasis ? "text-lg text-primary" : "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function VarianceBadge({
  variance,
  compact = false,
}: {
  variance: number;
  compact?: boolean;
}) {
  const tone =
    variance === 0
      ? "bg-success-soft text-success"
      : variance < 0
        ? "bg-danger-soft text-danger"
        : "bg-accent/20 text-primary-deep";
  const label =
    variance === 0
      ? "Balanced"
      : variance < 0
        ? `Short ${formatAmount(Math.abs(variance))}`
        : `Over ${formatAmount(variance)}`;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full font-semibold",
        compact ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm",
        tone,
      )}
    >
      {label}
    </span>
  );
}

function OpenTillDialog({
  open,
  onClose,
  operator,
}: {
  open: boolean;
  onClose: () => void;
  operator: string;
}) {
  const [float, setFloat] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await openTill({
        openingFloat: parseMoney(float),
        openedBy: operator,
      });
      setFloat("");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the till.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Open the till"
      description={`Starting float · opened by ${operator}`}
      dismissible={!saving}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-5"
      >
        <div>
          <label
            htmlFor="opening-float"
            className="text-sm font-semibold text-foreground"
          >
            Starting cash in the drawer
          </label>
          <input
            id="opening-float"
            inputMode="numeric"
            autoComplete="off"
            value={float}
            onChange={(event) => setFloat(event.target.value)}
            placeholder="0"
            className="mt-2 h-14 w-full rounded-xl border border-border bg-card px-4 text-right font-serif text-3xl font-semibold text-foreground tabular-nums transition-colors outline-none placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
          <p className="mt-2 text-xs leading-5 text-muted">
            Count the notes and coins already in the drawer. Cash taken during
            the shift is added to this figure.
          </p>
        </div>

        {error !== null ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-12 flex-1 rounded-xl border border-border bg-card text-sm font-semibold text-muted transition-colors hover:border-primary/35 hover:text-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex h-12 flex-[1.6] items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-cream transition-colors hover:bg-primary-deep disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {saving ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <Unlock aria-hidden="true" className="size-4" />
            )}
            Open till
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CloseTillDialog({
  open,
  onClose,
  operator,
  expectedCash,
  till,
}: {
  open: boolean;
  onClose: () => void;
  operator: string;
  expectedCash: number | null;
  till: LocalTillSession | null;
}) {
  const [counted, setCounted] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const countedValue = parseMoney(counted);
  const expected = expectedCash ?? till?.openingFloat ?? 0;
  const variance =
    counted.length === 0 ? null : toWholeShillings(countedValue - expected);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await closeTill({ countedCash: countedValue, closedBy: operator });
      setCounted("");
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not close the till.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Close the till"
      description={`Counted by ${operator}`}
      dismissible={!saving}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-5"
      >
        <div className="flex items-baseline justify-between rounded-2xl border border-border bg-well/50 px-4 py-3">
          <span className="text-sm font-semibold text-muted">Expected</span>
          <span className="font-serif text-2xl font-semibold text-foreground tabular-nums">
            {formatAmount(expected)}
          </span>
        </div>

        <div>
          <label
            htmlFor="counted-cash"
            className="text-sm font-semibold text-foreground"
          >
            Counted cash
          </label>
          <input
            id="counted-cash"
            inputMode="numeric"
            autoComplete="off"
            value={counted}
            onChange={(event) => setCounted(event.target.value)}
            placeholder="0"
            className="mt-2 h-14 w-full rounded-xl border border-border bg-card px-4 text-right font-serif text-3xl font-semibold text-foreground tabular-nums transition-colors outline-none placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
        </div>

        <div
          aria-live="polite"
          className="flex items-center justify-between gap-3"
        >
          <span className="text-sm font-semibold text-muted">Variance</span>
          {variance === null ? (
            <span className="text-sm text-muted">Enter the count</span>
          ) : (
            <VarianceBadge variance={variance} />
          )}
        </div>

        {error !== null ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-12 flex-1 rounded-xl border border-border bg-card text-sm font-semibold text-muted transition-colors hover:border-primary/35 hover:text-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || counted.length === 0}
            className="flex h-12 flex-[1.6] items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-cream transition-colors hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {saving ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <Check aria-hidden="true" className="size-4" />
            )}
            Close till
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Digits only; empty is zero. See the same helper in the checkout dialog. */
function parseMoney(input: string): number {
  const digits = input.replace(/[^\d]/g, "");
  if (digits.length === 0) return 0;
  return Number.parseInt(digits, 10);
}
