"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { FileText, Minus, Plus, ShoppingBag, Trash2, X } from "lucide-react";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { cartItemCount, type CartState } from "@/lib/cart";
import { formatAmount, pluralize } from "@/lib/format";
import { getDb } from "@/lib/db";
import type { SaleTotals } from "@/lib/sales";

const DISCOUNT_PRESET = 10;

/**
 * The basket.
 *
 * A full-height column, not a drawer: on a till the cart is never secondary, it
 * is the other half of the screen. The action that ends the transaction sits at
 * the bottom edge, where a hand already is.
 *
 * Line changes animate with `layout`, so incrementing a quantity slides the
 * lines below it rather than snapping. Removals fade out through
 * `AnimatePresence` — a line that vanishes instantly reads as a glitch. Both
 * are skipped under `prefers-reduced-motion`.
 */
export function CartPanel({
  state,
  totals,
  onIncrement,
  onDecrement,
  onRemove,
  onClear,
  onSetDiscount,
  onCharge,
  onCreateQuotation,
  busy = false,
}: {
  state: CartState;
  totals: SaleTotals;
  onIncrement: (productId: string) => void;
  onDecrement: (productId: string) => void;
  onRemove: (productId: string) => void;
  onClear: () => void;
  onSetDiscount: (percent: number) => void;
  onCharge: () => void;
  onCreateQuotation: () => void;
  busy?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const [discountCode, setDiscountCode] = useState("");
  const [discountError, setDiscountError] = useState<string | null>(null);
  const itemCount = cartItemCount(state);
  const empty = state.lines.length === 0;
  const discountOn = totals.discountPercent > 0;
  const hasDiscount = totals.discountKes > 0;

  return (
    <section
      aria-label="Cart"
      className="flex h-full min-h-0 flex-col rounded-3xl border border-border bg-card shadow-card"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-2.5">
          <ShoppingBag aria-hidden="true" className="size-4 text-primary" />
          <h2 className="font-serif text-lg font-semibold tracking-tight text-foreground">
            Cart
          </h2>
          <span className="rounded-full bg-well px-2 py-0.5 text-xs font-semibold text-muted tabular-nums">
            {itemCount} {pluralize(itemCount, "item")}
          </span>
        </div>

        <button
          type="button"
          onClick={onClear}
          disabled={empty}
          className="rounded-xl px-2.5 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Clear
        </button>
      </header>

      <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-well text-muted">
              <ShoppingBag aria-hidden="true" className="size-6" />
            </span>
            <p className="mt-3 text-sm font-semibold text-foreground">
              Nothing in the cart
            </p>
            <p className="mt-1 text-xs leading-5 text-muted">
              Tap a product, or scan its barcode.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            <AnimatePresence initial={false}>
              {state.lines.map((line) => (
                <motion.li
                  key={line.productId}
                  layout={reduceMotion ? false : "position"}
                  initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
                  className="overflow-hidden"
                >
                  <div className="rounded-2xl px-3 py-2.5 transition-colors hover:bg-well/70">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm leading-5 font-semibold text-foreground">
                        {line.name}
                      </p>
                      <button
                        type="button"
                        onClick={() => onRemove(line.productId)}
                        aria-label={`Remove ${line.name}`}
                        className="-mr-1 -mt-1 rounded-lg p-1.5 text-muted transition-colors hover:bg-danger-soft hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        <X aria-hidden="true" className="size-3.5" />
                      </button>
                    </div>

                    <div className="mt-2 flex items-center justify-between gap-3">
                      <QuantityStepper
                        name={line.name}
                        quantity={line.quantity}
                        max={line.maxQuantity}
                        onIncrement={() => onIncrement(line.productId)}
                        onDecrement={() => onDecrement(line.productId)}
                      />
                      <p className="font-serif text-base font-semibold text-foreground tabular-nums">
                        {formatAmount(line.unitPrice * line.quantity)}
                      </p>
                    </div>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>

      <footer className="border-t border-border px-5 pt-4 pb-5">
        <div className="mb-3 flex gap-2">
          <input
            value={discountCode}
            onChange={(e) => setDiscountCode(e.target.value)}
            placeholder="Discount code"
            className="flex-1 rounded-xl border border-border bg-well/60 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={async () => {
              const row = await getDb().pos_discounts.where("code").equals(discountCode.toUpperCase()).first();
              if (row && row.active) {
                onSetDiscount(row.percentage);
                setDiscountError(null);
              } else {
                setDiscountError("Invalid code");
              }
            }}
            className="rounded-xl bg-primary px-3 py-2 text-sm text-cream"
          >
            Apply
          </button>
        </div>
        {discountError ? <p className="mb-2 text-xs text-danger">{discountError}</p> : null}
        <button
          type="button"
          onClick={() => onSetDiscount(discountOn ? 0 : DISCOUNT_PRESET)}
          aria-pressed={discountOn}
          disabled={empty}
          className={cn(
            "flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            discountOn
              ? "border-accent bg-accent/15 text-primary-deep"
              : "border-border bg-well/60 text-muted hover:border-primary/35 hover:text-foreground",
            empty && "cursor-not-allowed opacity-40",
          )}
        >
          <span>{DISCOUNT_PRESET}% discount</span>
          <span className="text-xs tracking-[0.14em] uppercase">
            {discountOn ? "Applied" : "Off"}
          </span>
        </button>

        <dl className="mt-4 flex flex-col gap-1.5 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-muted">Subtotal</dt>
            <dd className="tabular-nums text-foreground">
              {formatAmount(totals.subtotalKes)}
            </dd>
          </div>
          {hasDiscount ? (
            <div className="flex items-center justify-between">
              <dt className="text-muted">
                Discount ({totals.discountPercent}%)
              </dt>
              <dd className="tabular-nums text-success">
                −{formatAmount(totals.discountKes)}
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-3 flex items-baseline justify-between border-t border-dashed border-border pt-3">
          <span className="text-sm font-semibold tracking-[0.14em] text-muted uppercase">
            Total
          </span>
          <span className="font-serif text-3xl font-semibold tracking-tight text-primary tabular-nums">
            {formatAmount(totals.totalKes)}
          </span>
        </div>

        <button
          type="button"
          onClick={onCreateQuotation}
          disabled={busy}
          className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-border bg-card text-sm font-semibold text-foreground transition-colors hover:border-primary/35 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45"
        >
          <FileText aria-hidden="true" className="size-4" />
          Create Quotation
        </button>

        <button
          type="button"
          onClick={onCharge}
          disabled={empty || busy}
          className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-base font-semibold text-cream shadow-card transition-colors hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {busy ? (
            "Saving…"
          ) : (
            <>
              Charge
              <span className="tabular-nums opacity-80">
                · {formatAmount(totals.totalKes)}
              </span>
            </>
          )}
        </button>
      </footer>
    </section>
  );
}

function QuantityStepper({
  name,
  quantity,
  max,
  onIncrement,
  onDecrement,
}: {
  name: string;
  quantity: number;
  max: number;
  onIncrement: () => void;
  onDecrement: () => void;
}) {
  const atCeiling = max > 0 && quantity >= max;

  return (
    <div className="inline-flex items-center rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={onDecrement}
        aria-label={`Decrease quantity of ${name}`}
        className="flex size-9 items-center justify-center rounded-s-xl text-muted transition-colors hover:bg-well hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        {quantity === 1 ? (
          <Trash2 aria-hidden="true" className="size-3.5" />
        ) : (
          <Minus aria-hidden="true" className="size-3.5" />
        )}
      </button>
      <span
        aria-live="polite"
        className="w-8 text-center text-sm font-semibold text-foreground tabular-nums"
      >
        {quantity}
      </span>
      <button
        type="button"
        onClick={onIncrement}
        disabled={atCeiling}
        aria-label={`Increase quantity of ${name}`}
        className="flex size-9 items-center justify-center rounded-e-xl text-muted transition-colors hover:bg-well hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <Plus aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}
