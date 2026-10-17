"use client";

import type { LocalSale } from "@/lib/db";
import { formatAmount } from "@/lib/format";
import { formatEatDateTime } from "@/lib/time";

/**
 * An 80mm receipt.
 *
 * Two decisions worth stating:
 *
 * 1. **It is black on white, regardless of the app's theme.** A thermal printer
 *    has one ink colour; a cream card with brown text would print as a grey
 *    smear. So this component deliberately opts out of the design tokens.
 * 2. **It is rendered from the stored sale, not from the cart.** A receipt
 *    reprinted next month must show what was actually charged, so nothing here
 *    reads live catalogue data.
 *
 * `w-[80mm]` plus the `@page { size: 80mm 297mm }` rule in globals.css is what
 * makes the browser's print dialog offer roll paper with no scaling. (The height
 * has to be a real length: see the note in globals.css on why `80mm auto` is
 * dropped by Chrome and would quietly fall back to Letter.)
 *
 * `id="receipt-print-area"` marks the one node `window.print()` is meant to
 * carry. The dialog is portalled to `document.body`, so the print rules in
 * globals.css are able to hide everything else and promote this element to the
 * top of the roll.
 */
export function Receipt({ sale }: { sale: LocalSale }) {
  const shortId = sale.clientUuid.slice(0, 8).toUpperCase();
  const method = describePayment(sale.paymentMethod);

  return (
    <article
      id="receipt-print-area"
      className="receipt-paper mx-auto w-[80mm] bg-white px-3 py-4 text-black"
      style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
    >
      <header className="text-center">
        <h3 className="text-[15px] leading-tight font-bold tracking-[0.18em] uppercase">
          Pedigree Leather
        </h3>
        <p className="mt-1 text-[11px] leading-tight">
          Handcrafted bags &amp; shoes — Nairobi
        </p>
      </header>

      <div className="my-3 border-t border-dashed border-black" />

      <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-[11px] leading-5">
        <dt>Receipt</dt>
        <dd className="text-right">{shortId}</dd>
        <dt>Date</dt>
        <dd className="text-right">{formatEatDateTime(sale.createdAt)}</dd>
        <dt>Served by</dt>
        <dd className="text-right">{sale.cashierName}</dd>
      </dl>

      <div className="my-3 border-t border-dashed border-black" />

      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-left">
            <th scope="col" className="font-normal">
              Item
            </th>
            <th scope="col" className="text-right font-normal">
              Qty
            </th>
            <th scope="col" className="text-right font-normal">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {sale.items.map((item) => (
            <tr key={item.id} className="align-top">
              <td className="py-1 pr-2">
                {item.productName}
                <br />
                <span className="text-[10px] opacity-70">
                  @ {formatAmount(item.priceAtSale)}
                </span>
              </td>
              <td className="py-1 text-right tabular-nums">{item.quantity}</td>
              <td className="py-1 text-right tabular-nums">
                {formatAmount(item.priceAtSale * item.quantity)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="my-3 border-t border-dashed border-black" />

      <dl className="grid grid-cols-[1fr_auto] gap-x-2 text-[11px] leading-5">
        <dt>Subtotal</dt>
        <dd className="tabular-nums">{formatAmount(sale.subtotalKes)}</dd>

        {sale.discountKes > 0 ? (
          <>
            <dt>Discount ({sale.discountPercent}%)</dt>
            <dd className="tabular-nums">−{formatAmount(sale.discountKes)}</dd>
          </>
        ) : null}

        <dt className="mt-1 border-t border-black pt-1 text-[13px] font-bold">
          TOTAL
        </dt>
        <dd className="mt-1 border-t border-black pt-1 text-right text-[13px] font-bold tabular-nums">
          KES {formatAmount(sale.totalKes)}
        </dd>
      </dl>

      <div className="my-3 border-t border-dashed border-black" />

      <dl className="grid grid-cols-[1fr_auto] gap-x-2 text-[11px] leading-5">
        <dt>Paid by</dt>
        <dd className="text-right uppercase">{method}</dd>

        {sale.paymentMethod === "cash" && sale.amountTendered !== null ? (
          <>
            <dt>Tendered</dt>
            <dd className="tabular-nums">{formatAmount(sale.amountTendered)}</dd>
            <dt className="font-bold">Change</dt>
            <dd className="text-right font-bold tabular-nums">
              {formatAmount(sale.changeDue ?? 0)}
            </dd>
          </>
        ) : null}

        {sale.paymentMethod !== "cash" && sale.paymentReference ? (
          <>
            <dt>
              {sale.paymentMethod === "mpesa" ? "Confirmation" : "Reference"}
            </dt>
            <dd className="text-right">{sale.paymentReference}</dd>
          </>
        ) : null}
      </dl>

      <div className="my-3 border-t border-dashed border-black" />

      <footer className="text-center text-[10px] leading-4">
        <p>Thank you — karibu tena.</p>
        <p className="mt-1 opacity-70">
          Goods exchanged within 14 days with this receipt.
        </p>
        <p className="mt-1 opacity-70">Not a VAT invoice.</p>
      </footer>
    </article>
  );
}

/** The receipt's word for a payment method. One place, so a label cannot drift. */
function describePayment(method: LocalSale["paymentMethod"]): string {
  switch (method) {
    case "cash":
      return "Cash";
    case "mpesa":
      return "M-Pesa";
    case "card":
      return "Card";
  }
}
