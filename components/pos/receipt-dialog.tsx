"use client";

import { useState } from "react";
import { Check, Mail, Printer } from "lucide-react";

import { Receipt } from "@/components/pos/receipt";
import { Modal } from "@/components/ui/modal";
import type { LocalSale } from "@/lib/db";
import { formatAmount } from "@/lib/format";
import { queueReceiptEmail } from "@/lib/sales";

/**
 * The end of a sale.
 *
 * The receipt is already saved by the time this opens — that ordering is
 * deliberate. Printing must never be able to lose a sale, so the money is on
 * disk before the dialog exists, and every action here (print, email, new sale)
 * is a way of *telling* someone about a sale that has already happened.
 */
export function ReceiptDialog({
  sale,
  open,
  onClose,
}: {
  sale: LocalSale | null;
  open: boolean;
  onClose: () => void;
}) {
  if (sale === null) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sale complete"
      description={`KES ${formatAmount(sale.totalKes)} taken · receipt ${sale.clientUuid.slice(0, 8).toUpperCase()}`}
      size="md"
    >
      {/* Mounted only while the dialog is open, so the email field starts empty
          for the next customer without an effect to clear it. */}
      <ReceiptBody sale={sale} onClose={onClose} />
    </Modal>
  );
}

function ReceiptBody({
  sale,
  onClose,
}: {
  sale: LocalSale;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [queued, setQueued] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-border bg-well/60 p-4">
        <Receipt sale={sale} />
      </div>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => window.print()}
          className="no-print flex h-12 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-cream transition-colors hover:bg-primary-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Printer aria-hidden="true" className="size-4" />
          Print receipt
        </button>

        <div className="no-print rounded-2xl border border-border p-4">
          <label
            htmlFor="receipt-email"
            className="flex items-center gap-2 text-sm font-semibold text-foreground"
          >
            <Mail aria-hidden="true" className="size-4 text-primary" />
            Email a copy
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="receipt-email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setQueued(false);
              }}
              placeholder="customer@example.com"
              className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-card px-3 text-sm text-foreground transition-colors outline-none placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            <button
              type="button"
              disabled={!looksLikeEmail(email) || queued}
              onClick={() => {
                void queueReceiptEmail({
                  clientUuid: sale.clientUuid,
                  email: email.trim(),
                });
                setQueued(true);
              }}
              className="h-11 rounded-xl border border-border bg-card px-4 text-sm font-semibold text-primary transition-colors hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Queue
            </button>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted">
            {queued ? (
              <span className="inline-flex items-center gap-1.5 font-semibold text-success">
                <Check aria-hidden="true" className="size-3.5" />
                Queued. It will send on its own — no need to wait.
              </span>
            ) : (
              "The receipt is stored on this device and sent when a connection is available, so the counter keeps moving."
            )}
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="no-print h-12 rounded-xl border border-border bg-card text-sm font-semibold text-foreground transition-colors hover:border-primary/35 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Start next sale
        </button>
      </div>
    </div>
  );
}

/**
 * Shape check only; the mail provider is the real validator. Mirrors the check
 * in the receipt-email route so the UI and the server agree.
 */
function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.includes("@") && trimmed.length >= 5 && trimmed.length <= 254;
}
