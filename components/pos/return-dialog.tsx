"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ArrowLeft,
  Check,
  Loader2,
  ReceiptText,
  Scan,
  Search,
  ShieldCheck,
} from "lucide-react";

import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import {
  getDb,
  type LocalReturn,
  type LocalSale,
  type PosPaymentMethod,
} from "@/lib/db";
import { formatAmount, formatTime } from "@/lib/format";
import { recordReturn } from "@/lib/returns";
import { useAuth } from "@/hooks/use-auth";

type Mode = "select" | "scan" | "confirm" | "done";

interface ReturnDialogProps {
  open: boolean;
  onClose: () => void;
  /** The manager who approved the return. */
  manager: { id: string; name: string };
  onReturnComplete: () => void;
}

interface ReturnableItem {
  id: string;
  productId: string;
  productName: string;
  quantity: number;
  priceAtSale: number;
  returnedQuantity: number;
  remainingQuantity: number;
}

interface ReturnSelection {
  productId: string;
  productName: string;
  /** How many units are still returnable. */
  quantity: number;
  soldQuantity: number;
  alreadyReturned: number;
  priceAtSale: number | null;
  saleDiscountPercent: number;
  defaultRefundMethod: PosPaymentMethod;
}

interface ReturnConfirmation {
  quantity: number;
  refundKes: number;
  refundMethod: PosPaymentMethod | null;
  refundReference: string | null;
}

/**
 * Mount the return flow only while it is open.
 *
 * The inner component owns every piece of return state. Remounting it is what
 * guarantees a fresh dialog — a new sale list and no leftover "Return recorded"
 * screen — without a reset effect that calls setState during render.
 */
export function ReturnDialog(props: ReturnDialogProps) {
  if (!props.open) return null;
  return <ReturnDialogContent {...props} />;
}

function ReturnDialogContent({
  open,
  onClose,
  manager,
  onReturnComplete,
}: ReturnDialogProps) {
  const { session } = useAuth();
  const [mode, setMode] = useState<Mode>("select");
  const [sales, setSales] = useState<LocalSale[]>([]);
  const [selectedSale, setSelectedSale] = useState<LocalSale | null>(null);
  const [selectedItem, setSelectedItem] = useState<ReturnSelection | null>(null);
  const [scanCode, setScanCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  const selectedSaleUuid = selectedSale?.clientUuid ?? null;

  useEffect(() => {
    if (mode === "scan") scanRef.current?.focus();
  }, [mode]);

  // Load recent sales when the dialog mounts. The wrapper unmounts this
  // component on close, so the list is refreshed on every open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const db = getDb();
        const list = await db.pos_sales.orderBy("createdAt").reverse().limit(20).toArray();
        if (!cancelled) setSales(list);
      } catch {
        if (!cancelled) setSales([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The ledger is the source of truth for already-returned units. Querying it
  // live means another tab's return appears here without reopening the dialog.
  const returnHistory = useLiveQuery(
    async () => {
      if (selectedSaleUuid === null) {
        return { saleUuid: null, records: [] as LocalReturn[] };
      }
      const records = await getDb()
        .local_returns.where("originalSaleUuid")
        .equals(selectedSaleUuid)
        .toArray();
      return { saleUuid: selectedSaleUuid, records };
    },
    [selectedSaleUuid],
  );

  const historyRecords = useMemo(() => {
    if (
      selectedSaleUuid === null ||
      returnHistory?.saleUuid !== selectedSaleUuid
    ) {
      return [] as LocalReturn[];
    }
    return returnHistory.records;
  }, [selectedSaleUuid, returnHistory]);

  const historyLoading =
    selectedSaleUuid !== null && returnHistory?.saleUuid !== selectedSaleUuid;

  const returnableItems = useMemo<ReturnableItem[]>(() => {
    if (selectedSale === null) return [];

    const returnedByProduct = new Map<string, number>();
    for (const record of historyRecords) {
      for (const item of record.items) {
        returnedByProduct.set(
          item.productId,
          (returnedByProduct.get(item.productId) ?? 0) + item.quantity,
        );
      }
    }

    return selectedSale.items
      .filter((item) => item.productId !== null)
      .map((item) => {
        const productId = item.productId;
        if (productId === null) return null;
        const returnedQuantity = returnedByProduct.get(productId) ?? 0;
        return {
          id: item.id,
          productId,
          productName: item.productName,
          quantity: item.quantity,
          priceAtSale: item.priceAtSale,
          returnedQuantity,
          remainingQuantity: Math.max(0, item.quantity - returnedQuantity),
        };
      })
      .filter((item): item is ReturnableItem => item !== null);
  }, [selectedSale, historyRecords]);

  function back() {
    setError(null);
    setSelectedItem(null);
    setMode("select");
  }

  function handleSelectItem(item: ReturnableItem) {
    if (selectedSale === null || item.remainingQuantity <= 0) return;
    setSelectedItem({
      productId: item.productId,
      productName: item.productName,
      quantity: item.remainingQuantity,
      soldQuantity: item.quantity,
      alreadyReturned: item.returnedQuantity,
      priceAtSale: item.priceAtSale,
      saleDiscountPercent: selectedSale.discountPercent,
      defaultRefundMethod: selectedSale.paymentMethod,
    });
    setError(null);
    setMode("confirm");
  }

  async function handleConfirm(confirmation: ReturnConfirmation) {
    if (selectedItem === null || session === null) return;

    // ConfirmReturn clamps, but this is the last gate before the ledger. The
    // ledger repeats the check inside its transaction for a second tab.
    const max = Math.max(1, selectedItem.quantity);
    const quantity = Math.max(
      1,
      Math.min(max, Math.floor(confirmation.quantity)),
    );

    setSaving(true);
    setError(null);
    try {
      await recordReturn({
        originalSale: selectedSale,
        items: [
          {
            productId: selectedItem.productId,
            productName: selectedItem.productName,
            quantity,
          },
        ],
        cashierId: selectedSale?.cashierId ?? null,
        cashierName: selectedSale?.cashierName ?? "",
        managerId: manager.id,
        managerName: manager.name,
        refundKes: confirmation.refundKes,
        refundMethod: confirmation.refundMethod,
        refundReference: confirmation.refundReference,
      });
      setMode("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record the return.");
    } finally {
      setSaving(false);
    }
  }

  async function handleScan() {
    setError(null);
    const code = scanCode.trim();
    if (code.length === 0) {
      setError("Scan or type a barcode.");
      return;
    }

    setSaving(true);
    try {
      const db = getDb();
      const product = await db.products.where("barcode").equals(code).first();
      if (product === undefined) {
        setError("No product with that barcode.");
        return;
      }

      setSelectedSale(null);
      setSelectedItem({
        productId: product.id,
        productName: product.name,
        quantity: 1,
        soldQuantity: 1,
        alreadyReturned: 0,
        priceAtSale: null,
        saleDiscountPercent: 0,
        defaultRefundMethod: "cash",
      });
      setMode("confirm");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not look up the barcode.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === "done" ? "Return recorded" : "Return / Refund"}
      description={
        mode === "done"
          ? "Stock and any refund have been recorded and queued for Supabase."
          : "Pick the returned goods, confirm the quantity and refund. Stock goes back up locally right away."
      }
      size="md"
      dismissible={mode !== "done"}
    >
      {mode === "done" ? (
        <DoneReturn onClose={onClose} onReturnComplete={onReturnComplete} />
      ) : (
        <>
          <header className="flex items-center justify-between gap-2 mb-2">
            <button
              type="button"
              onClick={back}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm font-semibold text-muted transition-colors hover:bg-well disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
              Back
            </button>
            <span className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">
              Approved by {manager.name}
            </span>
          </header>

          {mode === "select" ? (
            <SelectSale
              sales={sales}
              returnableItems={returnableItems}
              selectedSale={selectedSale}
              historyLoading={historyLoading}
              onSelectSale={(sale) => {
                setSelectedSale(sale);
                setSelectedItem(null);
                setError(null);
              }}
              onSelectItem={handleSelectItem}
              onScan={() => {
                setError(null);
                setMode("scan");
              }}
              saving={saving}
            />
          ) : null}

          {mode === "scan" ? (
            <ScanSale
              scanCode={scanCode}
              setScanCode={setScanCode}
              error={error}
              onScan={() => void handleScan()}
              saving={saving}
              scanRef={scanRef}
            />
          ) : null}

          {mode === "confirm" && selectedItem !== null ? (
            <ConfirmReturn
              item={selectedItem}
              onConfirm={(confirmation) => void handleConfirm(confirmation)}
              saving={saving}
              error={error}
            />
          ) : null}

          {mode === "select" && error !== null ? (
            <p role="alert" className="mt-4 text-sm font-medium text-danger">
              {error}
            </p>
          ) : null}
        </>
      )}
    </Modal>
  );
}

function SelectSale({
  sales,
  returnableItems,
  selectedSale,
  historyLoading,
  onSelectSale,
  onSelectItem,
  onScan,
  saving,
}: {
  sales: LocalSale[];
  returnableItems: ReturnableItem[];
  selectedSale: LocalSale | null;
  historyLoading: boolean;
  onSelectSale: (sale: LocalSale) => void;
  onSelectItem: (item: ReturnableItem) => void;
  onScan: () => void;
  saving: boolean;
}) {
  if (sales.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-well text-muted/70 mb-3">
          <ReceiptText aria-hidden="true" className="size-6" />
        </span>
        <p className="text-sm text-muted">No recent sales to return against.</p>
        <button
          type="button"
          onClick={onScan}
          disabled={saving}
          className="mt-6 h-11 rounded-xl border border-border bg-card px-4 text-sm font-semibold text-muted transition-colors hover:bg-well focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Scan a barcode instead
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">
        Select a recent sale
      </p>
      <ul className="divide-y divide-border/60 rounded-2xl border border-border bg-card shadow-sm">
        {sales.map((sale) => {
          const hasReturnable = sale.items.some((item) => item.productId !== null);
          return (
            <li key={sale.clientUuid}>
              <button
                type="button"
                onClick={() => onSelectSale(sale)}
                disabled={!hasReturnable || saving}
                className={cn(
                  "flex w-full items-center justify-between gap-4 px-5 py-3.5 text-left transition-colors",
                  selectedSale?.clientUuid === sale.clientUuid
                    ? "bg-primary/10 text-primary"
                    : "text-muted hover:bg-well hover:text-foreground",
                  !hasReturnable || saving
                    ? "opacity-50 cursor-not-allowed"
                    : "",
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground truncate">
                    {sale.cashierName}
                  </p>
                  <p className="text-xs text-muted truncate">
                    {formatTime(sale.createdAt)} · {sale.items.reduce((sum, i) => sum + i.quantity, 0)} item(s) · KES {formatAmount(sale.totalKes)}
                  </p>
                </div>
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-well text-[0.6875rem] font-semibold text-muted">
                  {sale.clientUuid.slice(0, 4).toUpperCase()}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {selectedSale !== null && returnableItems.length > 0 ? (
        <div className="mt-4 flex flex-col gap-2 rounded-2xl border border-border bg-well/60 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-muted uppercase">Return item</p>
            {historyLoading ? (
              <span className="text-xs font-medium text-muted">Checking returns…</span>
            ) : null}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {returnableItems.map((item) => {
              const exhausted = item.remainingQuantity === 0;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelectItem(item)}
                  disabled={saving || historyLoading || exhausted}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-xl border border-border bg-card px-3 py-2.5 text-sm font-semibold text-left transition-colors hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-50",
                    exhausted ? "opacity-60" : "",
                  )}
                >
                  <span className="line-clamp-1">{item.productName}</span>
                  <span className="text-xs text-muted">
                    {exhausted
                      ? "Fully returned"
                      : `${item.remainingQuantity} of ${item.quantity} left`}
                  </span>
                </button>
              );
            })}
          </div>
          {!historyLoading &&
          returnableItems.every((item) => item.remainingQuantity === 0) ? (
            <p className="text-sm text-muted">
              Every unit on this sale has already been returned.
            </p>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        onClick={onScan}
        disabled={saving}
        className="mt-1 h-11 rounded-xl border border-border bg-card px-4 text-sm font-semibold text-muted transition-colors hover:bg-well focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Return without a receipt
      </button>
    </div>
  );
}

function ScanSale({
  scanCode,
  setScanCode,
  error,
  onScan,
  saving,
  scanRef,
}: {
  scanCode: string;
  setScanCode: (v: string) => void;
  error: string | null;
  onScan: () => void;
  saving: boolean;
  scanRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onScan();
      }}
      className="flex flex-col gap-3"
    >
      <p className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">
        Scan the returned item
      </p>
      <div className="relative w-full">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input
          ref={scanRef}
          autoFocus
          inputMode="numeric"
          autoComplete="off"
          value={scanCode}
          onChange={(event) => setScanCode(event.target.value)}
          placeholder="Barcode"
          className="h-12 w-full rounded-xl border border-border bg-card pl-10 pr-4 text-sm text-foreground transition-colors outline-none focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
      </div>
      <p className="text-xs leading-5 text-muted">
        Use this for a return without a receipt. It records one unit against the
        scanned product; add a refund manually on the next screen if money was
        handed back.
      </p>
      {error !== null ? (
        <p role="alert" className="mt-2 text-sm font-medium text-danger">{error}</p>
      ) : null}
      <div className="mt-4 flex items-center gap-2">
        <button
          type="submit"
          disabled={saving || scanCode.trim().length === 0}
          className="flex-1 h-11 rounded-xl bg-primary text-sm font-semibold text-cream transition-colors hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {saving ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin mr-2" />
          ) : (
            <Scan aria-hidden="true" className="size-4 mr-2" />
          )}
          Find item
        </button>
        <button
          type="button"
          onClick={() => setScanCode("")}
          className="h-11 rounded-xl border border-border bg-card px-3 text-sm font-semibold text-muted transition-colors hover:bg-well focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Clear
        </button>
      </div>
    </form>
  );
}

function ConfirmReturn({
  item,
  onConfirm,
  saving,
  error,
}: {
  item: ReturnSelection;
  onConfirm: (confirmation: ReturnConfirmation) => void;
  saving: boolean;
  error: string | null;
}) {
  const max = Math.max(1, item.quantity);
  const [quantity, setQuantity] = useState(1);
  const [refundOverride, setRefundOverride] = useState<string | null>(null);
  const [refundMethod, setRefundMethod] = useState<PosPaymentMethod>(
    item.defaultRefundMethod,
  );
  const [refundReference, setRefundReference] = useState("");

  const defaultRefund =
    item.priceAtSale === null
      ? 0
      : Math.max(
          0,
          Math.round(
            item.priceAtSale *
              quantity *
              (1 - item.saleDiscountPercent / 100),
          ),
        );
  const refundText = refundOverride ?? String(defaultRefund);
  const refundKes = parseMoney(refundText);
  const effectiveRefundMethod = refundKes > 0 ? refundMethod : null;
  const effectiveReference =
    refundKes > 0 && refundMethod !== "cash"
      ? refundReference.trim() || null
      : null;

  function submit() {
    onConfirm({
      quantity,
      refundKes,
      refundMethod: effectiveRefundMethod,
      refundReference: effectiveReference,
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">
        Confirm return
      </p>
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-sm font-semibold text-foreground">{item.productName}</p>
        <p className="text-xs text-muted">
          {item.alreadyReturned > 0
            ? `${item.alreadyReturned} of ${item.soldQuantity} already returned · ${max} left`
            : `Returning up to ${max} ${max === 1 ? "unit" : "units"}`}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <label htmlFor="return-quantity" className="text-xs text-muted">
            Quantity to return
          </label>
          <input
            id="return-quantity"
            type="number"
            min="1"
            max={max}
            value={quantity}
            onChange={(event) => {
              const v = Math.max(
                1,
                Math.min(max, Number.parseInt(event.target.value, 10) || 1),
              );
              setQuantity(v);
            }}
            className="h-9 w-20 rounded-xl border border-border bg-card text-center text-sm font-semibold text-foreground"
          />
        </div>

        <div className="mt-4 border-t border-border pt-4">
          <label
            htmlFor="return-refund"
            className="text-sm font-semibold text-foreground"
          >
            Refund to customer (KES)
          </label>
          <input
            id="return-refund"
            inputMode="numeric"
            autoComplete="off"
            value={refundText}
            onChange={(event) =>
              setRefundOverride(event.target.value.replace(/[^\d]/g, ""))
            }
            placeholder="0"
            className="mt-2 h-12 w-full rounded-xl border border-border bg-card px-4 text-right font-serif text-2xl font-semibold text-foreground tabular-nums transition-colors outline-none placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          />
          <p className="mt-1.5 text-xs leading-5 text-muted">
            {item.priceAtSale === null
              ? "No sale selected. Leave this at zero for a stock-only return, or enter what was handed back."
              : item.saleDiscountPercent > 0
                ? `Default is the sale price less the ${item.saleDiscountPercent}% basket discount. Override it if the actual refund differed.`
                : "Default is the price paid at the sale. Override it if the actual refund differed."}
          </p>

          <div className="mt-3">
            <p className="text-xs font-semibold tracking-[0.12em] text-muted uppercase">
              Refund method
            </p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {(["cash", "mpesa", "card"] as const).map((method) => (
                <button
                  key={method}
                  type="button"
                  onClick={() => setRefundMethod(method)}
                  aria-pressed={refundMethod === method}
                  className={cn(
                    "h-10 rounded-xl border text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    refundMethod === method
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-card text-muted hover:border-primary/40",
                  )}
                >
                  {method === "cash" ? "Cash" : method === "mpesa" ? "M-Pesa" : "Card"}
                </button>
              ))}
            </div>
          </div>

          {refundKes > 0 && refundMethod !== "cash" ? (
            <div className="mt-3">
              <label
                htmlFor="return-refund-reference"
                className="text-xs font-semibold tracking-[0.12em] text-muted uppercase"
              >
                Reference (optional)
              </label>
              <input
                id="return-refund-reference"
                value={refundReference}
                onChange={(event) => setRefundReference(event.target.value)}
                placeholder={
                  refundMethod === "mpesa" ? "M-Pesa code" : "Card slip reference"
                }
                className="mt-2 h-10 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground transition-colors outline-none focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
            </div>
          ) : null}

          {refundKes === 0 ? (
            <p className="mt-3 rounded-xl bg-well/70 px-3 py-2 text-xs font-medium text-muted">
              No money is being refunded — this return only puts stock back.
            </p>
          ) : null}
        </div>

        {error !== null ? (
          <p role="alert" className="mt-3 text-sm font-medium text-danger">{error}</p>
        ) : null}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className="flex-1 h-11 rounded-xl bg-primary text-sm font-semibold text-cream transition-colors hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {saving ? (
            <>
              <Loader2 aria-hidden="true" className="size-4 animate-spin mr-2" />
              Recording…
            </>
          ) : (
            <>
              <ShieldCheck aria-hidden="true" className="size-4 mr-2" />
              {refundKes > 0
                ? `Refund KES ${formatAmount(refundKes)} & return`
                : "Put stock back"}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

function DoneReturn({
  onClose,
  onReturnComplete,
}: {
  onClose: () => void;
  onReturnComplete: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 py-2 text-center">
      <Check aria-hidden="true" className="size-12 text-success" />
      <h3 className="font-serif text-lg font-semibold tracking-tight text-foreground">
        Return recorded
      </h3>
      <p className="text-sm text-muted max-w-xs">
        Stock and any refund have been recorded on this till, and the return is
        queued to reach Supabase the next time the machine syncs.
      </p>
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={onReturnComplete}
          className="h-11 rounded-xl bg-primary px-5 text-sm font-semibold text-cream transition-colors hover:bg-primary-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Done
        </button>
        <button
          type="button"
          onClick={onClose}
          className="h-11 rounded-xl border border-border bg-card px-5 text-sm font-semibold text-muted transition-colors hover:bg-well focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Close
        </button>
      </div>
    </div>
  );
}

/** Digits only; empty is zero. See the same helper in the cash drawer. */
function parseMoney(input: string): number {
  const digits = input.replace(/[^\d]/g, "");
  if (digits.length === 0) return 0;
  return Number.parseInt(digits, 10);
}
