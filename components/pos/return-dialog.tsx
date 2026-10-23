"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Loader2, ReceiptText, Scan, Search, ShieldCheck } from "lucide-react";

import { Modal } from "@/components/ui/modal";
import { cn } from "@/lib/cn";
import { getDb, type LocalSale } from "@/lib/db";
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
  const [selectedItem, setSelectedItem] = useState<{
    productId: string;
    productName: string;
    quantity: number;
  } | null>(null);
  const [returnQuantity, setReturnQuantity] = useState(1);
  const [scanCode, setScanCode] = useState("");
  const [scannedProduct, setScannedProduct] = useState<{
    productId: string;
    productName: string;
    stockQuantity: number;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

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

  const returnableItems = useMemo(() => {
    if (selectedSale === null) return [];
    return selectedSale.items.filter((item) => item.productId !== null);
  }, [selectedSale]);

  function back() {
    setError(null);
    setMode("select");
  }

  async function handleConfirm(quantity: number) {
    if (selectedItem === null || session === null) return;

    // The input in ConfirmReturn is authoritative. Clamp it here as well so a
    // caller cannot return more units than the original line contained.
    const max = Math.max(1, selectedItem.quantity);
    const returnQuantity = Math.max(
      1,
      Math.min(max, Math.floor(quantity)),
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
            quantity: returnQuantity,
          },
        ],
        cashierId: selectedSale?.cashierId ?? null,
        cashierName: selectedSale?.cashierName ?? "",
        managerId: manager.id,
        managerName: manager.name,
      });
      setMode("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not record the return.");
    } finally {
      setSaving(false);
    }
  }

  function handleScan() {
    setError(null);
    if (scanCode.trim().length === 0) {
      setError("Scan or type a barcode.");
      return;
    }
    void (async () => {
      const db = getDb();
      const product = await db.products
        .where("barcode")
        .equals(scanCode.trim())
        .first();
      if (product === undefined) {
        setScannedProduct(null);
        setError("No product with that barcode.");
        return;
      }
      setScannedProduct({
        productId: product.id,
        productName: product.name,
        stockQuantity: product.stockQuantity,
      });
      setSelectedSale(null);
      setSelectedItem({
        productId: product.id,
        productName: product.name,
        quantity: 1,
      });
      setReturnQuantity(1);
      setMode("confirm");
    })();
  }

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === "done" ? "Return recorded" : "Return / Refund"}
      description={
        mode === "done"
          ? "Stock has been put back and the return is queued for Supabase."
          : "Pick the returned goods, then confirm. Stock goes back up locally right away."
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
              onSelectSale={(sale) => {
                setSelectedSale(sale);
                setSelectedItem(null);
                setReturnQuantity(1);
              }}
              setReturnQuantity={setReturnQuantity}
              returnQuantity={returnQuantity}
              onSelectItem={(productId, productName, quantity) => {
                setSelectedItem({ productId, productName, quantity });
                setMode("confirm");
              }}
              onScan={() => setMode("scan")}
              saving={saving}
            />
          ) : null}

          {mode === "scan" ? (
            <ScanSale
              scanCode={scanCode}
              setScanCode={setScanCode}
              scannedProduct={scannedProduct}
              error={error}
              onScan={handleScan}
              saving={saving}
              scanRef={scanRef}
            />
          ) : null}

          {mode === "confirm" ? (
            <ConfirmReturn
              item={selectedItem!}
              returnQuantity={returnQuantity}
              setReturnQuantity={setReturnQuantity}
              onConfirm={handleConfirm}
              saving={saving}
              error={error}
            />
          ) : null}

          {mode !== "confirm" && error !== null ? (
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
  onSelectSale,
  setReturnQuantity,
  returnQuantity,
  onSelectItem,
  onScan,
  saving,
}: {
  sales: LocalSale[];
  returnableItems: LocalSale["items"];
  selectedSale: LocalSale | null;
  onSelectSale: (sale: LocalSale) => void;
  setReturnQuantity: (q: number) => void;
  returnQuantity: number;
  onSelectItem: (
    productId: string,
    productName: string,
    quantity: number,
  ) => void;
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
          <p className="text-xs font-semibold text-muted uppercase">Return item</p>
          <div className="grid grid-cols-2 gap-2">
            {returnableItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  const quantity = Math.max(
                    1,
                    Math.min(item.quantity, returnQuantity),
                  );
                  // Keep the original line quantity as the ceiling, and the
                  // chosen quantity as the starting value in ConfirmReturn.
                  onSelectItem(item.productId!, item.productName, item.quantity);
                  setReturnQuantity(quantity);
                }}
                disabled={saving}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-border bg-card px-2 py-2.5 text-sm font-semibold text-left transition-colors hover:border-primary/40 disabled:opacity-50"
              >
                <span className="line-clamp-1">{item.productName}</span>
                <span className="text-xs text-muted">x{item.quantity}</span>
              </button>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-muted">Quantity</span>
            <input
              type="number"
              min="1"
              value={returnQuantity}
              onChange={(event) => {
                const v = Math.max(1, Number.parseInt(event.target.value, 10) || 1);
                setReturnQuantity(v);
              }}
              className="h-9 w-16 rounded-xl border border-border bg-card text-center text-sm font-semibold text-foreground"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ScanSale({
  scanCode,
  setScanCode,
  scannedProduct,
  error,
  onScan,
  saving,
  scanRef,
}: {
  scanCode: string;
  setScanCode: (v: string) => void;
  scannedProduct: { productId: string; productName: string; stockQuantity: number } | null;
  error: string | null;
  onScan: () => void;
  saving: boolean;
  scanRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="flex flex-col gap-3">
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
      {error !== null ? (
        <p role="alert" className="mt-2 text-sm font-medium text-danger">{error}</p>
      ) : null}
      {scannedProduct !== null ? (
        <div className="mt-3 rounded-xl border border-border bg-success-soft p-3">
          <p className="text-sm font-semibold text-success">{scannedProduct.productName}</p>
          <p className="text-xs text-success/80">
            {scannedProduct.stockQuantity} in stock before return
          </p>
        </div>
      ) : null}
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={onScan}
          disabled={saving || scannedProduct === null}
          className="flex-1 h-11 rounded-xl bg-primary text-sm font-semibold text-cream transition-colors hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {saving ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Scan aria-hidden="true" className="size-4 mr-2" />}Scan
        </button>
        <button
          type="button"
          onClick={() => setScanCode("")}
          className="h-11 rounded-xl border border-border bg-card px-3 text-sm font-semibold text-muted transition-colors hover:bg-well focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

function ConfirmReturn({
  item,
  returnQuantity,
  setReturnQuantity,
  onConfirm,
  saving,
  error,
}: {
  item: { productId: string; productName: string; quantity: number };
  returnQuantity: number;
  setReturnQuantity: (q: number) => void;
  onConfirm: (quantity: number) => void;
  saving: boolean;
  error: string | null;
}) {
  const max = Math.max(1, item.quantity);
  const quantity = Math.min(returnQuantity, max);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-semibold tracking-[0.16em] text-muted uppercase">
        Confirm return
      </p>
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-sm font-semibold text-foreground">{item.productName}</p>
        <p className="text-xs text-muted">Returning up to {max} {max === 1 ? "unit" : "units"}</p>
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-muted">Quantity to return</span>
          <input
            type="number"
            min="1"
            max={max}
            value={quantity}
            onChange={(event) => {
              const v = Math.max(1, Math.min(max, Number.parseInt(event.target.value, 10) || 1));
              setReturnQuantity(v);
            }}
            className="h-9 w-20 rounded-xl border border-border bg-card text-center text-sm font-semibold text-foreground"
          />
        </div>
        {error !== null ? (
          <p role="alert" className="mt-3 text-sm font-medium text-danger">{error}</p>
        ) : null}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => onConfirm(quantity)}
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
              Put stock back
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
        Stock has been put back on this till, and the return is queued to reach
        Supabase the next time the machine syncs.
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


