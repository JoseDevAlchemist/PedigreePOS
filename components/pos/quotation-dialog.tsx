"use client";

import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  FileText,
  Loader2,
  Mail,
  Minus,
  Plus,
  Search,
  Trash2,
} from "lucide-react";

import { ProductGrid } from "@/components/pos/product-grid";
import { useToast } from "@/components/ui/toast-provider";
import { Modal } from "@/components/ui/modal";
import type { CartState } from "@/lib/cart";
import type { LocalProduct } from "@/lib/db";
import { effectivePrice, formatAmount } from "@/lib/format";
import {
  calculateQuotationTotals,
  createQuotationNumber,
  MPESA_TILL,
  quotationWhatsAppText,
  QUOTATION_VALIDITY_DAYS,
  type QuotationData,
  type QuotationItem,
} from "@/lib/quotations";
import { sendQuotationEmail } from "@/app/actions/send-quotation";

interface QuoteLine extends QuotationItem {
  key: string;
  color: string;
  maxQuantity: number;
}

/**
 * Build a quotation without leaving the till.
 *
 * The cart is the starting point when it has lines, but a quotation can also be
 * built from scratch through the same product grid the cashier already knows.
 * Nothing here decrements stock or writes a sale: a quotation is a document,
 * not a transaction.
 */
export function QuotationDialog({
  open,
  onClose,
  products,
  cart,
}: {
  open: boolean;
  onClose: () => void;
  products: LocalProduct[];
  cart: CartState;
}) {
  if (!open) return null;

  return (
    <QuotationDialogBody
      onClose={onClose}
      products={products}
      cart={cart}
    />
  );
}

function QuotationDialogBody({
  onClose,
  products,
  cart,
}: {
  onClose: () => void;
  products: LocalProduct[];
  cart: CartState;
}) {
  const { toast } = useToast();
  const [lines, setLines] = useState<QuoteLine[]>(() =>
    seedLines(cart, products),
  );
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [query, setQuery] = useState("");
  const [generated, setGenerated] = useState<QuotationData | null>(null);
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredProducts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return products;
    return products.filter(
      (product) =>
        product.name.toLowerCase().includes(needle) ||
        product.slug.toLowerCase().includes(needle) ||
        (product.barcode ?? "").toLowerCase().includes(needle) ||
        (product.qrCode ?? "").toLowerCase().includes(needle),
    );
  }, [products, query]);

  const totals = useMemo(
    () => calculateQuotationTotals({ items: lines, discountPercent: 0 }),
    [lines],
  );

  function addProduct(product: LocalProduct) {
    const color = product.colors[0]?.trim() ?? "";
    const price = effectivePrice(product.basePrice, product.discountPercent);

    setLines((current) => {
      const existing = current.find(
        (line) => line.productId === product.id && line.color === color,
      );
      if (existing !== undefined) {
        return current.map((line) =>
          line.key === existing.key
            ? {
                ...line,
                quantity: clampQuantity(line.quantity + 1, line.maxQuantity),
              }
            : line,
        );
      }

      return [
        ...current,
        {
          key: crypto.randomUUID(),
          productId: product.id,
          name: product.name,
          color,
          quantity: 1,
          unitPrice: price,
          imageUrl: product.imageUrl,
          maxQuantity: Math.max(1, product.stockQuantity),
        },
      ];
    });
    setError(null);
  }

  function updateQuantity(key: string, quantity: number) {
    setLines((current) =>
      current.map((line) =>
        line.key === key
          ? { ...line, quantity: clampQuantity(quantity, line.maxQuantity) }
          : line,
      ),
    );
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((line) => line.key !== key));
  }

  function updateColor(key: string, color: string) {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, color } : line)),
    );
  }

  function generateQuotation() {
    if (customerName.trim().length === 0) {
      setError("Enter the customer's name.");
      return;
    }
    if (lines.length === 0) {
      setError("Add at least one item to the quotation.");
      return;
    }

    setError(null);
    setCopied(false);
    setGenerated({
      quotationNumber: createQuotationNumber(),
      customerName: customerName.trim(),
      customerEmail: customerEmail.trim() || null,
      customerPhone: customerPhone.trim() || null,
      items: lines.map((line) => ({
        productId: line.productId,
        name: line.name,
        color: line.color,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        imageUrl: line.imageUrl,
      })),
      discountPercent: 0,
      createdAt: new Date().toISOString(),
    });
  }

  async function emailQuotation() {
    if (generated === null) return;
    const email = (generated.customerEmail ?? "").trim();
    if (!looksLikeEmail(email)) {
      setError("Enter a valid customer email address before sending.");
      return;
    }

    setSending(true);
    setError(null);
    try {
      const result = await sendQuotationEmail(email, generated);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({
        variant: "success",
        title: "Quotation sent",
        description: `Emailed ${generated.quotationNumber} to ${email}.`,
      });
    } catch {
      setError("Could not send the quotation. Please try again.");
    } finally {
      setSending(false);
    }
  }

  async function copyForWhatsApp() {
    if (generated === null) return;
    try {
      await navigator.clipboard.writeText(quotationWhatsAppText(generated));
      setCopied(true);
      setError(null);
      toast({
        variant: "success",
        title: "Copied for WhatsApp",
        description: "Paste the message into the customer's chat.",
      });
    } catch {
      setError("Could not copy to the clipboard. Please copy manually.");
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={generated === null ? "Create quotation" : "Quotation ready"}
      description={
        generated === null
          ? "Build a quote from the catalogue, then email it or copy it for WhatsApp."
          : `${generated.quotationNumber} · KES ${formatAmount(totals.totalKes)}`
      }
      size="lg"
    >
      {generated === null ? (
        <div className="flex flex-col gap-6">
          <section className="grid gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-semibold text-foreground">Customer name</span>
              <input
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
                placeholder="e.g. Amina Wanjiru"
                className="h-11 rounded-xl border border-border bg-card px-3 text-sm outline-none transition-colors placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-semibold text-foreground">Email</span>
              <input
                type="email"
                value={customerEmail}
                onChange={(event) => setCustomerEmail(event.target.value)}
                placeholder="customer@example.com"
                className="h-11 rounded-xl border border-border bg-card px-3 text-sm outline-none transition-colors placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-semibold text-foreground">Phone</span>
              <input
                type="tel"
                value={customerPhone}
                onChange={(event) => setCustomerPhone(event.target.value)}
                placeholder="07XX XXX XXX"
                className="h-11 rounded-xl border border-border bg-card px-3 text-sm outline-none transition-colors placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
            </label>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground">
                Quotation items
              </h3>
              <span className="text-xs text-muted">
                {lines.length} {lines.length === 1 ? "line" : "lines"}
              </span>
            </div>

            {lines.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border bg-well/40 px-4 py-8 text-center text-sm text-muted">
                Add products below, or build the cart first and open this form.
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {lines.map((line) => (
                  <li
                    key={line.key}
                    className="rounded-2xl border border-border bg-card p-3"
                  >
                    <div className="flex items-start gap-3">
                      <QuoteThumb line={line} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-semibold text-foreground">
                            {line.name}
                          </p>
                          <button
                            type="button"
                            onClick={() => removeLine(line.key)}
                            aria-label={`Remove ${line.name}`}
                            className="rounded-lg p-1.5 text-muted transition-colors hover:bg-danger-soft hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            <Trash2 aria-hidden="true" className="size-3.5" />
                          </button>
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <input
                            value={line.color}
                            onChange={(event) =>
                              updateColor(line.key, event.target.value)
                            }
                            placeholder="Colour"
                            aria-label={`Colour for ${line.name}`}
                            className="h-9 w-32 rounded-xl border border-border bg-well/50 px-2.5 text-xs text-foreground outline-none transition-colors placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          />
                          <QuoteQuantity
                            name={line.name}
                            quantity={line.quantity}
                            max={line.maxQuantity}
                            onChange={(quantity) =>
                              updateQuantity(line.key, quantity)
                            }
                          />
                          <span className="ms-auto text-xs text-muted">
                            KES {formatAmount(line.unitPrice)} each
                          </span>
                          <span className="font-serif text-base font-semibold text-foreground tabular-nums">
                            {formatAmount(line.unitPrice * line.quantity)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground">
                Add from catalogue
              </h3>
              <span className="text-xs text-muted">
                Tap a product to add it
              </span>
            </div>
            <div className="relative mb-3">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted"
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search products…"
                aria-label="Search quotation products"
                className="h-10 w-full rounded-xl border border-border bg-card ps-9 pe-3 text-sm outline-none transition-colors placeholder:text-muted/50 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
            </div>
            <div className="max-h-80 overflow-y-auto pe-1">
              <ProductGrid
                products={filteredProducts}
                query={query}
                onAdd={addProduct}
              />
            </div>
          </section>

          <div className="rounded-2xl border border-border bg-well/50 p-4">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">Subtotal</span>
              <span className="font-semibold tabular-nums">
                KES {formatAmount(totals.subtotalKes)}
              </span>
            </div>
            <div className="mt-2 flex items-baseline justify-between border-t border-dashed border-border pt-3">
              <span className="text-sm font-semibold tracking-[0.14em] text-muted uppercase">
                Total
              </span>
              <span className="font-serif text-2xl font-semibold text-primary tabular-nums">
                KES {formatAmount(totals.totalKes)}
              </span>
            </div>
          </div>

          {error !== null ? (
            <p className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm font-semibold text-danger">
              {error}
            </p>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={onClose}
              className="h-12 flex-1 rounded-xl border border-border bg-card text-sm font-semibold text-foreground transition-colors hover:border-primary/35 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={generateQuotation}
              disabled={lines.length === 0}
              className="flex h-12 flex-[1.6] items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-cream transition-colors hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <FileText aria-hidden="true" className="size-4" />
              Generate Quotation
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <section className="rounded-2xl border border-border bg-well/50 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold tracking-[0.14em] text-muted uppercase">
                  Prepared for
                </p>
                <p className="mt-1 font-serif text-xl font-semibold text-foreground">
                  {generated.customerName}
                </p>
                {generated.customerPhone ? (
                  <p className="text-sm text-muted">{generated.customerPhone}</p>
                ) : null}
                {generated.customerEmail ? (
                  <p className="text-sm text-muted">{generated.customerEmail}</p>
                ) : null}
              </div>
              <div className="text-right text-xs text-muted">
                <p className="font-semibold text-foreground">
                  {generated.quotationNumber}
                </p>
                <p className="mt-1">Valid for {QUOTATION_VALIDITY_DAYS} days</p>
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-well text-left text-xs text-muted uppercase">
                <tr>
                  <th className="px-3 py-2 font-semibold">Item</th>
                  <th className="px-3 py-2 text-right font-semibold">Qty</th>
                  <th className="px-3 py-2 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody>
                {generated.items.map((item, index) => (
                  <tr
                    key={`${item.productId ?? item.name}-${index}`}
                    className="border-t border-border"
                  >
                    <td className="px-3 py-2">
                      <p className="font-semibold text-foreground">{item.name}</p>
                      {item.color ? (
                        <p className="text-xs text-muted">{item.color}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {item.quantity}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      KES {formatAmount(item.unitPrice * item.quantity)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-baseline justify-between border-t border-border bg-well/50 px-3 py-3">
              <span className="text-sm font-semibold text-foreground">Total</span>
              <span className="font-serif text-2xl font-semibold text-primary tabular-nums">
                KES {formatAmount(totals.totalKes)}
              </span>
            </div>
          </section>

          <section className="rounded-2xl border border-border p-4">
            <p className="text-xs font-semibold tracking-[0.14em] text-muted uppercase">
              Payment
            </p>
            <p className="mt-1 text-sm text-foreground">
              Pay via M-Pesa Till: <strong>{MPESA_TILL}</strong>
            </p>
            <p className="mt-1 text-xs text-muted">
              This quotation is valid for {QUOTATION_VALIDITY_DAYS} days.
            </p>
          </section>

          {error !== null ? (
            <p className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm font-semibold text-danger">
              {error}
            </p>
          ) : null}

          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => void emailQuotation()}
              disabled={
                sending || !looksLikeEmail(generated.customerEmail ?? "")
              }
              className="flex h-12 items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-cream transition-colors hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {sending ? (
                <Loader2 aria-hidden="true" className="size-4 animate-spin" />
              ) : (
                <Mail aria-hidden="true" className="size-4" />
              )}
              {sending ? "Sending…" : "Send by Email"}
            </button>

            <button
              type="button"
              onClick={() => void copyForWhatsApp()}
              className="flex h-12 items-center justify-center gap-2 rounded-xl border border-border bg-card text-sm font-semibold text-foreground transition-colors hover:border-primary/35 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {copied ? (
                <Check aria-hidden="true" className="size-4 text-success" />
              ) : (
                <Copy aria-hidden="true" className="size-4" />
              )}
              {copied ? "Copied for WhatsApp" : "Copy for WhatsApp"}
            </button>

            <button
              type="button"
              onClick={() => {
                setGenerated(null);
                setCopied(false);
                setError(null);
              }}
              className="flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-semibold text-muted transition-colors hover:bg-well hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <ArrowLeft aria-hidden="true" className="size-4" />
              Edit quotation
            </button>
          </div>

          {!looksLikeEmail(generated.customerEmail ?? "") ? (
            <p className="text-xs leading-5 text-muted">
              Add a customer email to send the PDF. Copy for WhatsApp works now.
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function QuoteThumb({ line }: { line: QuoteLine }) {
  if (line.imageUrl === null || line.imageUrl.length === 0) {
    return (
      <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-well text-muted">
        <FileText aria-hidden="true" className="size-5" />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- local/offline catalogue images
    <img
      src={line.imageUrl}
      alt=""
      className="size-12 shrink-0 rounded-xl object-cover"
    />
  );
}

function QuoteQuantity({
  name,
  quantity,
  max,
  onChange,
}: {
  name: string;
  quantity: number;
  max: number;
  onChange: (quantity: number) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => onChange(Math.max(1, quantity - 1))}
        disabled={quantity <= 1}
        aria-label={`Decrease quantity of ${name}`}
        className="flex size-8 items-center justify-center rounded-s-xl text-muted transition-colors hover:bg-well hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <Minus aria-hidden="true" className="size-3" />
      </button>
      <span className="w-7 text-center text-sm font-semibold tabular-nums">
        {quantity}
      </span>
      <button
        type="button"
        onClick={() => onChange(quantity + 1)}
        disabled={quantity >= max}
        aria-label={`Increase quantity of ${name}`}
        className="flex size-8 items-center justify-center rounded-e-xl text-muted transition-colors hover:bg-well hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <Plus aria-hidden="true" className="size-3" />
      </button>
    </div>
  );
}

function seedLines(cart: CartState, products: LocalProduct[]): QuoteLine[] {
  return cart.lines.map((line) => {
    const product = products.find((entry) => entry.id === line.productId);
    return {
      key: crypto.randomUUID(),
      productId: line.productId,
      name: line.name,
      color: product?.colors[0]?.trim() ?? "",
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      imageUrl: product?.imageUrl ?? null,
      maxQuantity: Math.max(1, line.maxQuantity),
    };
  });
}

function clampQuantity(quantity: number, max: number): number {
  if (!Number.isFinite(quantity)) return 1;
  return Math.max(1, Math.min(Math.floor(quantity), Math.max(1, max)));
}

function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.includes("@") &&
    trimmed.length >= 5 &&
    trimmed.length <= 254 &&
    !/\s/.test(trimmed)
  );
}
