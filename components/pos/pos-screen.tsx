"use client";

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Search, Undo2, X } from "lucide-react";

import { AppHeader } from "@/components/app-header";
import { CartPanel } from "@/components/pos/cart-panel";
import { CheckoutDialog, type CheckoutResult } from "@/components/pos/checkout-dialog";
import { ProductGrid } from "@/components/pos/product-grid";
import { QuotationDialog } from "@/components/pos/quotation-dialog";
import { ReceiptDialog } from "@/components/pos/receipt-dialog";
import { ReturnDialog } from "@/components/pos/return-dialog";
import { ReturnPinDialog } from "@/components/pos/return-pin-dialog";
import { SyncProvider } from "@/components/sync-provider";
import { runSync } from "@/lib/sync";
import { useAuth } from "@/hooks/use-auth";
import { useBarcodeScanner } from "@/hooks/use-barcode-scanner";
import { useProducts } from "@/hooks/use-products";
import {
  cartReducer,
  cartToCheckoutLines,
  emptyCart,
} from "@/lib/cart";
import { cn } from "@/lib/cn";
import type { LocalProduct, LocalSale } from "@/lib/db";
import { effectivePrice } from "@/lib/format";
import { completeSale, calculateTotals } from "@/lib/sales";
import { useCustomerDisplay } from "@/hooks/use-customer-display";

/**
 * The till.
 *
 * ## Layout
 *
 * A fixed-height app shell at `lg` and up: the chrome and the cart stay put and
 * only the catalogue scrolls. A till should never make a cashier scroll the
 * page to reach the total, and a cart that scrolls off the bottom is a cart that
 * gets mis-charged. Below `lg` the constraint is dropped and the page scrolls
 * normally, because a 900px layout squeezed onto a phone is worse than a plain
 * one.
 *
 * ## Scanning
 *
 * Two paths, on purpose. If nothing editable has focus, the global scanner hook
 * collects the keystrokes and adds on Enter. If the search box is focused — the
 * common case, because the cashier is one click away from typing — the scanner
 * types into the box and Enter resolves an exact barcode match. Either way the
 * product lands in the cart; neither path double-adds.
 */
export function PosScreen() {
  useEffect(() => {
    void (async () => {
      try {
        await runSync();
      } catch (error) {
        console.error("POS sync failed:", error);
      }
    })();
  }, []);
  const { session } = useAuth();
  const products = useProducts();

  const [cart, dispatch] = useReducer(cartReducer, emptyCart);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(
    null,
  );

  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [quotationOpen, setQuotationOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [completedSale, setCompletedSale] = useState<LocalSale | null>(null);

  // Returns need a manager's approval before stock can go back up.
  const [returnPinOpen, setReturnPinOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnManager, setReturnManager] = useState<{ id: string; name: string } | null>(
    null,
  );

  function handleManagerApproved(manager: { id: string; name: string }) {
    setReturnManager(manager);
    setReturnPinOpen(false);
    setReturnOpen(true);
  }

  function handleReturnComplete() {
    setReturnOpen(false);
    setReturnManager(null);
  }

  const totals = useMemo(
    () => calculateTotals(cartToCheckoutLines(cart), cart.discountPercent),
    [cart],
  );

  const { paint: paintCustomerDisplay } = useCustomerDisplay();

  // The customer-facing VFD paints the running total. Only the total is ever
  // painted — no item names, line prices or tender/change figures. An emptied
  // cart lands on 0 through the same path, because clearing the cart zeroes
  // the totals.
  useEffect(() => {
    paintCustomerDisplay(totals.totalKes);
  }, [totals.totalKes, paintCustomerDisplay]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const product of products) set.add(product.category);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [products]);

  const visible = useMemo(
    () => filterProducts(products, query, category),
    [products, query, category],
  );

  const flash = useCallback((tone: "ok" | "warn", text: string) => {
    setNotice({ tone, text });
    window.setTimeout(() => {
      setNotice((current) => (current?.text === text ? null : current));
    }, 2_600);
  }, []);

  const addToCart = useCallback(
    (product: LocalProduct) => {
      dispatch({
        type: "add",
        product: {
          productId: product.id,
          name: product.name,
          category: product.category,
          unitPrice: effectivePrice(product.basePrice, product.discountPercent),
          maxQuantity: product.stockQuantity,
        },
      });
    },
    [dispatch],
  );

  /** Resolve a scanned code, then put it in the cart. */
  const handleScan = useCallback(
    (code: string) => {
      const product = findByCode(products, code);
      if (product === null) {
        flash("warn", `No product with code ${code}`);
        return;
      }
      if (product.stockQuantity <= 0) {
        flash("warn", `${product.name} is out of stock`);
        return;
      }
      addToCart(product);
      flash("ok", `Added ${product.name}`);
    },
    [products, addToCart, flash],
  );

  // Paused while a dialog owns the screen, and while the search box has focus
  // (the hook checks the focused element itself).
  useBarcodeScanner({
    onScan: handleScan,
    paused: checkoutOpen || completedSale !== null,
  });

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    // An exact barcode in the search box is a scan, not a search: add it.
    const product = findByCode(products, query);
    if (product !== null) {
      event.preventDefault();
      handleScan(query);
      setQuery("");
    }
  }

  function handleConfirm(result: CheckoutResult) {
    if (session === null) return;
    setSaving(true);
    setCheckoutError(null);

    void (async () => {
      try {
        const sale = await completeSale({
          cashierId: session.id,
          cashierName: session.name,
          items: cartToCheckoutLines(cart),
          discountPercent: cart.discountPercent,
          paymentMethod: result.paymentMethod,
          amountTendered: result.amountTendered,
          paymentReference: result.paymentReference,
        });

        // Clear before showing the receipt: a cart left behind is a cart that
        // gets charged twice by a distracted cashier.
        dispatch({ type: "clear" });
        setCheckoutOpen(false);
        setCompletedSale(sale);
      } catch (error) {
        setCheckoutError(
          error instanceof Error ? error.message : "Could not save the sale.",
        );
      } finally {
        setSaving(false);
      }
    })();
  }

  return (
    <>
      <SyncProvider />
      <AppHeader current="pos" />

      <main className="mx-auto flex w-full max-w-[1800px] flex-1 flex-col gap-6 px-4 py-6 lg:h-[calc(100dvh-4rem)] lg:min-h-0 lg:flex-row lg:overflow-hidden lg:px-8">
        <div className="flex min-w-0 flex-1 flex-col gap-4 lg:min-h-0">
          <div className="flex flex-col gap-3">
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute start-4 top-1/2 size-4 -translate-y-1/2 text-muted"
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search a product, or scan a barcode…"
                aria-label="Search products"
                className="h-12 w-full rounded-2xl border border-border bg-card ps-11 pe-11 text-sm text-foreground shadow-card transition-colors outline-none placeholder:text-muted/60 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
              {query.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute end-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted transition-colors hover:bg-well hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <CategoryChip
                label="All"
                active={category === null}
                onClick={() => setCategory(null)}
              />
              {categories.map((name) => (
                <CategoryChip
                  key={name}
                  label={name}
                  active={category === name}
                  onClick={() => setCategory(name)}
                />
              ))}
            </div>

            <div className="min-h-6" aria-live="polite">
              {notice !== null ? (
                <p
                  className={cn(
                    "inline-flex rounded-full px-3 py-1 text-xs font-semibold",
                    notice.tone === "ok"
                      ? "bg-success-soft text-success"
                      : "bg-danger-soft text-danger",
                  )}
                >
                  {notice.text}
                </p>
              ) : (
                <p className="text-xs text-muted">
                  {visible.length} of {products.length} shown
                </p>
              )}
            </div>

            <div className="mt-2 flex justify-end">
              <button
                type="button"
                onClick={() => setReturnPinOpen(true)}
                disabled={session === null}
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold text-muted transition-colors hover:bg-well hover:text-danger hover:border-danger/40 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <Undo2 aria-hidden="true" className="size-4" />
                Return / Refund
              </button>
            </div>
          </div>

          <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pe-1 scrollbar-none">
            <ProductGrid products={visible} query={query} onAdd={addToCart} />
          </div>
        </div>

        <aside className="w-full lg:w-[360px] lg:shrink-0 xl:w-[420px] lg:h-full">
          <CartPanel
            state={cart}
            totals={totals}
            onIncrement={(productId) => dispatch({ type: "increment", productId })}
            onDecrement={(productId) => dispatch({ type: "decrement", productId })}
            onRemove={(productId) => dispatch({ type: "remove", productId })}
            onClear={() => dispatch({ type: "clear" })}
            onSetDiscount={(percent) => dispatch({ type: "setDiscount", percent })}
            onCharge={() => {
              setCheckoutError(null);
              setCheckoutOpen(true);
            }}
            onCreateQuotation={() => setQuotationOpen(true)}
            busy={saving}
          />
        </aside>
      </main>

      <CheckoutDialog
        open={checkoutOpen}
        totals={totals}
        itemCount={cart.lines.reduce((sum, line) => sum + line.quantity, 0)}
        onClose={() => setCheckoutOpen(false)}
        onConfirm={handleConfirm}
        saving={saving}
        error={checkoutError}
      />

      <ReceiptDialog
        sale={completedSale}
        open={completedSale !== null}
        onClose={() => setCompletedSale(null)}
      />

      <QuotationDialog
        open={quotationOpen}
        onClose={() => setQuotationOpen(false)}
        products={products}
        cart={cart}
      />

      <ReturnPinDialog
        open={returnPinOpen}
        onClose={() => setReturnPinOpen(false)}
        onApprove={handleManagerApproved}
      />

      <ReturnDialog
        open={returnOpen}
        onClose={() => setReturnOpen(false)}
        manager={returnManager ?? { id: "", name: "" }}
        onReturnComplete={handleReturnComplete}
      />
    </>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        active
          ? "border-primary bg-primary text-cream"
          : "border-border bg-card text-muted hover:border-primary/40 hover:text-primary",
      )}
    >
      {label}
    </button>
  );
}

/**
 * Look a code up the way a scanner expects: barcode, then QR code, then slug.
 *
 * Case-insensitive, because scanner output case is a coin toss, and exact — a
 * partial match on a scan would add the wrong product, which is worse than not
 * adding one.
 */
export function findByCode(
  products: LocalProduct[],
  code: string,
): LocalProduct | null {
  const needle = code.trim().toLowerCase();
  if (needle.length === 0) return null;

  const matches = (value: string | null | undefined) =>
    value !== null && value !== undefined && value.toLowerCase() === needle;

  return (
    products.find((product) => matches(product.barcode)) ??
    products.find((product) => matches(product.qrCode)) ??
    products.find((product) => product.slug.toLowerCase() === needle) ??
    null
  );
}

/** Free-text search across the fields a cashier might remember. */
function filterProducts(
  products: LocalProduct[],
  query: string,
  category: string | null,
): LocalProduct[] {
  const needle = query.trim().toLowerCase();

  return products.filter((product) => {
    if (category !== null && product.category !== category) return false;
    if (needle.length === 0) return true;

    return (
      product.name.toLowerCase().includes(needle) ||
      product.slug.toLowerCase().includes(needle) ||
      (product.barcode ?? "").toLowerCase().includes(needle) ||
      (product.qrCode ?? "").toLowerCase().includes(needle) ||
      product.category.toLowerCase().includes(needle)
    );
  });
}
