"use client";

import { useState } from "react";
import { PackageSearch, ShoppingBag } from "lucide-react";

import { cn } from "@/lib/cn";
import type { LocalProduct } from "@/lib/db";
import {
  effectivePrice,
  formatAmount,
  hasDiscount,
  pluralize,
} from "@/lib/format";

/**
 * The catalogue, as tappable cards.
 *
 * A grid rather than a table: a cashier works by recognition and position, not
 * by reading rows, and a card gives every product a large target. Everything
 * that decides whether a product can be sold — photograph, price, discount,
 * stock — is on the card, so adding to the cart never requires opening anything.
 */
export function ProductGrid({
  products,
  query,
  onAdd,
}: {
  products: LocalProduct[];
  query: string;
  onAdd: (product: LocalProduct) => void;
}) {
  if (products.length === 0) {
    return <GridEmpty query={query} />;
  }

  return (
    <ul
      // `list-none` is not needed (Tailwind's preflight removes markers), but
      // the explicit role keeps the count announced as a list.
      className="grid grid-cols-2 gap-3 xl:grid-cols-3 2xl:grid-cols-4"
    >
      {products.map((product) => (
        <li key={product.id}>
          <ProductCard product={product} onAdd={onAdd} />
        </li>
      ))}
    </ul>
  );
}

function ProductCard({
  product,
  onAdd,
}: {
  product: LocalProduct;
  onAdd: (product: LocalProduct) => void;
}) {
  const price = effectivePrice(product.basePrice, product.discountPercent);
  const discounted = hasDiscount(product.discountPercent);
  const outOfStock = product.stockQuantity <= 0;
  const lowStock = !outOfStock && product.stockQuantity <= 3;

  return (
    <button
      type="button"
      onClick={() => onAdd(product)}
      disabled={outOfStock}
      aria-label={
        outOfStock
          ? `${product.name}, out of stock`
          : `Add ${product.name} to cart, ${formatAmount(price)} shillings`
      }
      className={cn(
        "group flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border bg-card text-left shadow-card transition-[transform,box-shadow,border-color] duration-150",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        outOfStock
          ? "cursor-not-allowed opacity-55"
          : "hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-card-lift active:translate-y-0 active:scale-[0.99]",
      )}
    >
      <ProductThumb product={product} />

      <span className="flex flex-1 flex-col p-4">
        <span className="line-clamp-2 min-h-10 text-sm leading-5 font-semibold text-foreground">
          {product.name}
        </span>

        <span className="mt-1 text-[0.6875rem] font-semibold tracking-[0.14em] text-muted uppercase">
          {product.category}
        </span>

        <span className="mt-3 flex items-baseline gap-2">
          <span className="font-serif text-xl font-semibold tracking-tight text-primary tabular-nums">
            {formatAmount(price)}
          </span>
          {discounted ? (
            <span className="text-xs text-muted line-through tabular-nums">
              {formatAmount(product.basePrice)}
            </span>
          ) : null}
        </span>

        <span
          className={cn(
            "mt-3 inline-flex w-fit items-center rounded-full px-2.5 py-1 text-[0.6875rem] font-semibold",
            outOfStock
              ? "bg-danger-soft text-danger"
              : lowStock
                ? "bg-accent/20 text-primary-deep"
                : "bg-well text-muted",
          )}
        >
          {outOfStock
            ? "Out of stock"
            : `${product.stockQuantity} ${pluralize(product.stockQuantity, "left")}`}
        </span>
      </span>
    </button>
  );
}

/**
 * The card's photograph, or a placeholder in its place.
 *
 * A plain `<img>`, not `next/image`, and for the same reason the rest of the
 * till is built the way it is: the optimizer is a server round trip, and a
 * server round trip is exactly what the shop does not have during an outage.
 * The browser's own HTTP cache, primed while online, keeps the grid populated
 * offline; `next/image` would ask the network again for every thumbnail.
 *
 * A remote photo can still fail — a deleted object, a blocked host — so a load
 * error falls back to the same placeholder as a product with no photography at
 * all. `alt` is empty because the card is a single button with an accessible
 * name already; a description here would be read out twice.
 */
function ProductThumb({ product }: { product: LocalProduct }) {
  const [failed, setFailed] = useState(false);
  const src = product.imageUrl;

  if (src === null || src === "" || failed) {
    return (
      <span
        aria-hidden="true"
        className="flex h-32 w-full items-center justify-center rounded-t-lg bg-well text-muted/70"
      >
        <ShoppingBag className="size-8" />
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- see the note above
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className="h-32 w-full rounded-t-lg object-cover"
    />
  );
}

function GridEmpty({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/50 px-6 py-20 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-well text-muted">
        <PackageSearch aria-hidden="true" className="size-6" />
      </span>
      <p className="mt-4 font-serif text-lg font-semibold text-foreground">
        {query.length > 0 ? "Nothing matches that" : "No products on this till"}
      </p>
      <p className="mt-1 max-w-xs text-sm leading-6 text-muted">
        {query.length > 0
          ? `No product matches “${query}”. Try the barcode, or part of the name.`
          : "The catalogue has not reached this device yet. It will load on the next sync."}
      </p>
    </div>
  );
}
