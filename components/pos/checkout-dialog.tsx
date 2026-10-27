"use client";

import { useMemo, useRef, useState } from "react";
import { Banknote, CreditCard, Loader2, Smartphone } from "lucide-react";

import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import type { PosPaymentMethod } from "@/lib/db";
import { formatAmount, toWholeShillings } from "@/lib/format";
import type { SaleTotals } from "@/lib/sales";

/**
 * Taking the money.
 *
 * Three methods, and the form changes between them because they are different
 * acts. Cash is arithmetic the till does for the cashier — tendered minus total
 * — so the change is the largest thing on the panel and cannot be got wrong.
 * M-Pesa and Card are both a code the cashier reads off a machine and writes
 * down; the only useful thing the till can do there is insist on the code and
 * record it against the sale.
 *
 * M-Pesa is the exception that now has a real provider behind it: Lipa Na M-Pesa
 * (STK Push) via `/api/pos/mpesa/stk-push`, with the prompt sent from the server
 * (the Consumer Secret and Passkey never leave it) and the outcome logged and
 * parsed at `/api/pos/mpesa/callback`. Until those are configured the till
 * degrades to the manual fallback — the cashier reads the confirmation code off
 * the customer's phone and types it, exactly as before — so a sale can never be
 * blocked by an unattended payment provider.
 *
 * Quick-tender buttons are the notes that actually circulate in Nairobi, in
 * descending order, so the common case is one tap.
 */

const QUICK_TENDER = [1000, 500, 200, 100];

/** Shortest code accepted for M-Pesa or card. Real codes are longer; this only
 * rejects an obviously half-typed one. */
const MIN_REFERENCE_LENGTH = 4;

/** The cashier's M-Pesa states. `idle` offers the prompt and the manual route;
 * `sending` is the in-flight prompt; `waiting` is the prompt dispatched and the
 * customer is being asked to approve; `manual` is the fallback where the cashier
 * reads the confirmation code off the phone and types it.
 */
type MpesaPhase = "idle" | "sending" | "waiting" | "manual";

export interface CheckoutResult {
  paymentMethod: PosPaymentMethod;
  amountTendered: number | null;
  paymentReference: string | null;
}

export function CheckoutDialog({
  open,
  totals,
  itemCount,
  onClose,
  onConfirm,
  saving,
  error,
}: {
  open: boolean;
  totals: SaleTotals;
  itemCount: number;
  onClose: () => void;
  onConfirm: (result: CheckoutResult) => void;
  saving: boolean;
  error: string | null;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Take payment"
      description={`${itemCount} ${itemCount === 1 ? "item" : "items"} · KES ${formatAmount(totals.totalKes)}`}
      dismissible={!saving}
    >
      {/*
        The form owns the payment fields, and the modal only renders it while it
        is open — so it unmounts on every close and the next customer gets a
        blank form with no effect needed to clear the last one's amount.
      */}
      <CheckoutForm
        totals={totals}
        itemCount={itemCount}
        onClose={onClose}
        onConfirm={onConfirm}
        saving={saving}
        error={error}
      />
    </Modal>
  );
}

function CheckoutForm({
  totals,
  itemCount,
  onClose,
  onConfirm,
  saving,
  error,
}: {
  totals: SaleTotals;
  itemCount: number;
  onClose: () => void;
  onConfirm: (result: CheckoutResult) => void;
  saving: boolean;
  error: string | null;
}) {
  const [method, setMethod] = useState<PosPaymentMethod>("cash");
  const [tendered, setTendered] = useState("");
  const [reference, setReference] = useState("");

  const [phoneNumber, setPhoneNumber] = useState("");
  const [mpesaPhase, setMpesaPhase] = useState<MpesaPhase>("idle");
  const [mpesaError, setMpesaError] = useState<string | null>(null);

  const tenderedInputRef = useRef<HTMLInputElement>(null);

  const tenderedValue = useMemo(() => parseMoney(tendered), [tendered]);
  const change = toWholeShillings(tenderedValue - totals.totalKes);
  const short = method === "cash" && tenderedValue < totals.totalKes;
  const referenceReady = reference.trim().length >= MIN_REFERENCE_LENGTH;

  const canConfirm =
    !saving &&
    itemCount > 0 &&
    (method === "cash"
      ? tenderedValue >= totals.totalKes
      : method === "mpesa"
        ? mpesaPhase === "manual" && referenceReady
        : referenceReady);

  async function handleSendStkPush(): Promise<void> {
    if (saving) return;

    const digits = phoneNumber.replace(/[^\d]/g, "");
    if (digits.length < 9) {
      setMpesaError("Enter the customer's phone number to send the M-Pesa prompt.");
      return;
    }

    setMpesaPhase("sending");
    setMpesaError(null);

    try {
      const response = await fetch("/api/pos/mpesa/stk-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amountKes: totals.totalKes,
          phoneNumber: phoneNumber.trim(),
          accountReference: `PED-${Date.now()}`,
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;

      if (!response.ok || data?.ok !== true) {
        // Robust fallback: the prompt could not be sent, so fall back to the
        // cashier reading the confirmation code off the customer's phone rather
        // than dead-ending the sale.
        setMpesaError(
          `The M-Pesa prompt could not be sent (${data?.error ?? `HTTP ${response.status}`}). Enter the customer's confirmation code manually instead.`,
        );
        setMpesaPhase("manual");
        return;
      }

      setMpesaPhase("waiting");
    } catch {
      setMpesaError(
        "Could not reach the M-Pesa service. Enter the customer's confirmation code manually instead.",
      );
      setMpesaPhase("manual");
    }
  }

  function handleMethodChange(value: PosPaymentMethod) {
    setMethod(value);
    // Leaving M-Pesa resets its state; arriving starts a clean prompt flow.
    if (value !== "mpesa") {
      setMpesaPhase("idle");
      setPhoneNumber("");
      setMpesaError(null);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!canConfirm) return;
        onConfirm(
          method === "cash"
            ? {
                paymentMethod: "cash",
                amountTendered: tenderedValue,
                paymentReference: null,
              }
            : {
                paymentMethod: method,
                amountTendered: null,
                paymentReference: reference.trim(),
              },
        );
      }}
      className="flex flex-col gap-6"
    >
      <fieldset>
        <legend className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">
          Payment method
        </legend>
        <div className="mt-2 grid grid-cols-3 gap-2">
          <MethodOption
            value="cash"
            current={method}
            onSelect={setMethod}
            icon={<Banknote aria-hidden="true" className="size-4" />}
            label="Cash"
            hint="Work out the change"
          />
          <MethodOption
            value="mpesa"
            current={method}
            onSelect={handleMethodChange}
            icon={<Smartphone aria-hidden="true" className="size-4" />}
            label="M-Pesa"
            hint="Send prompt or code"
          />
          <MethodOption
            value="card"
            current={method}
            onSelect={handleMethodChange}
            icon={<CreditCard aria-hidden="true" className="size-4" />}
            label="Card"
            hint="Record reference"
          />
        </div>
      </fieldset>

      {method === "cash" ? (
        <div className="rounded-2xl border border-border bg-well/50 p-4">
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold text-muted">
              Amount tendered
            </span>
            <span className="text-xs text-muted">
              Total KES {formatAmount(totals.totalKes)}
            </span>
          </div>

          <input
            ref={tenderedInputRef}
            // `inputMode` gives a numeric keypad on a touch till while still
            // allowing an external numpad on a keyboard one.
            inputMode="numeric"
            autoComplete="off"
            aria-label="Amount tendered in shillings"
            value={tendered}
            onChange={(event) => setTendered(event.target.value)}
            placeholder="0"
            className="mt-2 h-14 w-full rounded-xl border border-border bg-card px-4 text-right font-serif text-3xl font-semibold text-foreground tabular-nums transition-colors outline-none placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />

          <div className="mt-3 flex flex-wrap gap-2">
            <QuickTenderButton
              label="Exact"
              onClick={() => setTendered(String(totals.totalKes))}
            />
            {QUICK_TENDER.filter((note) => note >= totals.totalKes).map(
              (note) => (
                <QuickTenderButton
                  key={note}
                  label={formatAmount(note)}
                  onClick={() => setTendered(String(note))}
                />
              ),
            )}
          </div>

          <div
            aria-live="polite"
            className={cn(
              "mt-4 flex items-baseline justify-between rounded-xl px-3 py-2.5",
              short ? "bg-danger-soft" : "bg-success-soft",
            )}
          >
            <span
              className={cn(
                "text-sm font-semibold",
                short ? "text-danger" : "text-success",
              )}
            >
              {short ? "Short by" : "Change due"}
            </span>
            <span
              className={cn(
                "font-serif text-2xl font-semibold tabular-nums",
                short ? "text-danger" : "text-success",
              )}
            >
              {formatAmount(short ? totals.totalKes - tenderedValue : change)}
            </span>
          </div>
        </div>
      ) : method === "card" ? (
        <div className="rounded-2xl border border-border bg-well/50 p-4">
          <label htmlFor="payment-reference" className="text-sm font-semibold text-muted">
            Card reference
          </label>
          <input
            id="payment-reference"
            autoComplete="off"
            spellCheck={false}
            value={reference}
            onChange={(event) => setReference(event.target.value.toUpperCase())}
            placeholder="e.g. 004123"
            maxLength={24}
            className="mt-2 h-14 w-full rounded-xl border border-border bg-card px-4 font-mono text-xl font-semibold tracking-[0.12em] text-foreground uppercase transition-colors outline-none placeholder:text-muted/40 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
          <p className="mt-3 text-xs leading-5 text-muted">
            Read it off the card terminal slip. It goes on the receipt for reconciliation against the card settlement.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-border bg-well/50 p-4">
          {mpesaPhase === "manual" ? (
            <>
              <label htmlFor="payment-reference" className="text-sm font-semibold text-muted">
                M-Pesa confirmation code
              </label>
              <input
                id="payment-reference"
                autoComplete="off"
                spellCheck={false}
                value={reference}
                onChange={(event) => setReference(event.target.value.toUpperCase())}
                placeholder="e.g. SJK7Q2LM1P"
                maxLength={24}
                className="mt-2 h-14 w-full rounded-xl border border-border bg-card px-4 font-mono text-xl font-semibold tracking-[0.12em] text-foreground uppercase transition-colors outline-none placeholder:text-muted/40 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
              <p className="mt-3 text-xs leading-5 text-muted">
                Read it off the customer&apos;s phone. It goes on the receipt, so it can be matched against the M-Pesa statement later.
              </p>
            </>
          ) : (
            <>
              <label htmlFor="mpesa-phone" className="text-sm font-semibold text-muted">
                Customer phone number
              </label>
              <input
                id="mpesa-phone"
                inputMode="tel"
                autoComplete="off"
                aria-label="Customer phone number"
                value={phoneNumber}
                onChange={(event) => setPhoneNumber(event.target.value)}
                placeholder="e.g. 0700123456"
                disabled={mpesaPhase === "sending"}
                className="mt-2 h-14 w-full rounded-xl border border-border bg-card px-4 font-mono text-xl font-semibold tracking-[0.12em] text-foreground tabular-nums transition-colors outline-none placeholder:text-muted/40 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
              />
              {mpesaPhase === "idle" ? (
                <button
                  type="button"
                  onClick={() => void handleSendStkPush()}
                  disabled={saving}
                  className="mt-3 h-12 w-full rounded-xl bg-primary text-sm font-semibold text-cream transition-colors hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  Send M-Pesa prompt
                </button>
              ) : null}
              {mpesaPhase === "idle" ? (
                <button
                  type="button"
                  onClick={() => setMpesaPhase("manual")}
                  disabled={saving}
                  className="mt-2 h-12 w-full rounded-xl border border-border bg-card text-sm font-semibold text-muted transition-colors hover:border-primary/35 hover:text-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  Enter the code manually
                </button>
              ) : null}
            </>
          )}

          {mpesaPhase === "sending" ? (
            <p role="status" className="mt-3 text-sm font-medium text-muted">
              Sending the M-Pesa prompt…
            </p>
          ) : null}

          {mpesaPhase === "waiting" ? (
            <div className="mt-3 flex flex-col gap-3">
              <p role="status" className="text-sm font-medium text-success">
                Prompt sent — waiting for {phoneNumber.trim()} to approve.
              </p>
              <button
                type="button"
                onClick={() => setMpesaPhase("manual")}
                disabled={saving}
                className="h-12 w-full rounded-xl border border-border bg-card text-sm font-semibold text-muted transition-colors hover:border-primary/35 hover:text-foreground disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Enter the code manually
              </button>
            </div>
          ) : null}

          {mpesaError !== null ? (
            <p role="alert" className="mt-3 text-sm font-medium text-danger">
              {mpesaError}
            </p>
          ) : null}
        </div>
      )}

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
          disabled={!canConfirm}
          className="flex h-12 flex-[1.6] items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-cream transition-colors hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {saving ? (
            <>
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              Saving sale…
            </>
          ) : (
            `Complete sale · KES ${formatAmount(totals.totalKes)}`
          )}
        </button>
      </div>
    </form>
  );
}

function MethodOption({
  value,
  current,
  onSelect,
  icon,
  label,
  hint,
}: {
  value: PosPaymentMethod;
  current: PosPaymentMethod;
  onSelect: (method: PosPaymentMethod) => void;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  const selected = value === current;

  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-pressed={selected}
      className={cn(
        "flex flex-col items-start gap-1 rounded-2xl border px-3 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        selected
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-card text-muted hover:border-primary/35",
      )}
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {label}
      </span>
      <span className="text-xs opacity-80">{hint}</span>
    </button>
  );
}

function QuickTenderButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-xl border border-border bg-card px-3 py-2 text-xs font-semibold text-muted transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {label}
    </button>
  );
}

/**
 * Parse typed money. Empty is zero; anything non-numeric is dropped rather than
 * throwing a `NaN` into the change calculation, where it would silently disable
 * the confirm button with no explanation.
 */
function parseMoney(input: string): number {
  const digits = input.replace(/[^\d]/g, "");
  if (digits.length === 0) return 0;
  return Number.parseInt(digits, 10);
}
