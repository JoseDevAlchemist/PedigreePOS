"use client";

import {
  getDb,
  newUuid,
  nowIso,
  type LocalSale,
  type LocalSaleItem,
  type PosPaymentMethod,
} from "@/lib/db";
import { toWholeShillings } from "@/lib/format";
import { countPending } from "@/lib/sync";
import { eatDayKey, eatDayRange } from "@/lib/time";

/**
 * Recording a sale.
 *
 * Everything here is local and synchronous in spirit: it writes IndexedDB and
 * appends to the sync queue, and it never waits on the network. That is the
 * whole reason the till can keep trading through an outage, so no function in
 * this file may `await` a fetch.
 */

export interface CheckoutLine {
  productId: string | null;
  productName: string;
  /** `bag` or `shoe`, captured with the line so the sale can be reported by it. */
  category: string | null;
  quantity: number;
  priceAtSale: number;
}

export interface CompleteSaleInput {
  cashierId: string | null;
  cashierName: string;
  items: CheckoutLine[];
  /** Basket-level discount, 0–100. The till offers 10%. */
  discountPercent: number;
  paymentMethod: PosPaymentMethod;
  /** Cash only. */
  amountTendered?: number | null;
  /**
   * `mpesa`: the confirmation code from the customer's phone. `card`: the
   * reference off the card terminal receipt. Ignored for cash.
   */
  paymentReference?: string | null;
}

export interface SaleTotals {
  subtotalKes: number;
  discountKes: number;
  discountPercent: number;
  totalKes: number;
}

/**
 * The arithmetic, in one place so the cart, the checkout dialog and the
 * receipt can never disagree about what is owed.
 *
 * Rounded once, at the end: rounding the discount and then the total is how you
 * get a receipt whose lines do not add up to its footer.
 */
export function calculateTotals(
  items: CheckoutLine[],
  discountPercent: number,
): SaleTotals {
  const subtotal = items.reduce(
    (sum, item) => sum + item.priceAtSale * item.quantity,
    0,
  );
  const percent = clampPercent(discountPercent);
  const discount = toWholeShillings((subtotal * percent) / 100);
  const total = toWholeShillings(subtotal) - discount;

  return {
    subtotalKes: toWholeShillings(subtotal),
    discountKes: discount,
    discountPercent: percent,
    totalKes: Math.max(0, total),
  };
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Persist a completed sale.
 *
 * One Dexie transaction covers the sale, the stock decrement and the queue
 * entry, so the three can never half-apply: a crash mid-way leaves either all
 * of it or none of it. The alternative — three separate writes — is how you end
 * up with a queue entry for a sale that was never stored.
 */
export async function completeSale(input: CompleteSaleInput): Promise<LocalSale> {
  if (input.items.length === 0) {
    throw new Error("Cannot record a sale with no items.");
  }

  const db = getDb();
  const totals = calculateTotals(input.items, input.discountPercent);
  const createdAt = nowIso();
  const clientUuid = newUuid();

  const amountTendered =
    input.paymentMethod === "cash" && input.amountTendered != null
      ? toWholeShillings(input.amountTendered)
      : null;
  const changeDue =
    amountTendered !== null ? Math.max(0, amountTendered - totals.totalKes) : null;

  const items: LocalSaleItem[] = input.items.map((item) => ({
    id: newUuid(),
    productId: item.productId,
    productName: item.productName,
    category: item.category,
    quantity: item.quantity,
    priceAtSale: item.priceAtSale,
  }));

  const sale: LocalSale = {
    clientUuid,
    cashierId: input.cashierId,
    cashierName: input.cashierName,
    subtotalKes: totals.subtotalKes,
    discountKes: totals.discountKes,
    discountPercent: totals.discountPercent,
    totalKes: totals.totalKes,
    paymentMethod: input.paymentMethod,
    amountTendered,
    changeDue,
    // Cash carries no reference; M-Pesa and card each carry the code the
    // cashier read off a machine, stored in the same field.
    paymentReference:
      input.paymentMethod === "cash"
        ? null
        : (input.paymentReference?.trim() || null),
    createdAt,
    syncedAt: null,
    createdOffline: typeof navigator !== "undefined" ? !navigator.onLine : false,
    items,
  };

  await db.transaction(
    "rw",
    db.pos_sales,
    db.products,
    db.sync_queue,
    async () => {
      await db.pos_sales.add(sale);

      // Decrement the till's own count. Stock may reach zero here and never go
      // negative: the goods have physically left, so the only question is
      // whether the count was right.
      for (const item of items) {
        if (item.productId === null) continue;
        await db.products
          .where("id")
          .equals(item.productId)
          .modify((product) => {
            product.stockQuantity = Math.max(
              0,
              product.stockQuantity - item.quantity,
            );
          });
      }

      await db.sync_queue.add({
        entity: "sale",
        entityId: clientUuid,
        status: "pending",
        attempts: 0,
        lastError: null,
        payload: null,
        createdAt,
        updatedAt: createdAt,
      });
    },
  );

  // Let the header's counter move before the network has been touched.
  await countPending();

  return sale;
}

export interface QueuedReceiptEmail {
  clientUuid: string;
  email: string;
}

/**
 * Queue a receipt to be emailed.
 *
 * Always a queue, even when the connection is up: delivery is somebody else's
 * job (the server endpoint), and the cashier must not wait on it to start the
 * next customer.
 */
export async function queueReceiptEmail(
  input: QueuedReceiptEmail,
): Promise<void> {
  const db = getDb();
  const now = nowIso();

  const existing = await db.sync_queue
    .where("entity")
    .equals("receipt_email")
    .filter((entry) => entry.entityId === input.clientUuid)
    .first();

  if (existing !== undefined) {
    if (existing.id !== undefined) {
      await db.sync_queue.update(existing.id, {
        payload: { email: input.email },
        status: "pending",
        lastError: null,
        updatedAt: now,
      });
    }
  } else {
    await db.sync_queue.add({
      entity: "receipt_email",
      entityId: input.clientUuid,
      status: "pending",
      attempts: 0,
      lastError: null,
      payload: { email: input.email },
      createdAt: now,
      updatedAt: now,
    });
  }

  await countPending();
}

/**
 * A Nairobi day's takings, computed locally.
 *
 * Deliberately local: the manager dashboard has to work during an outage, and
 * the till's database is the only place that has *every* sale — including the
 * ones Supabase has not seen yet.
 *
 * Deliberately Nairobi: "today" is an East Africa Time day (see lib/time.ts),
 * not whichever day the device's clock is in. The window is half-open so a sale
 * at exactly midnight belongs to one day and never two.
 */
export interface DailyTotals {
  /** The EAT calendar day this describes, `YYYY-MM-DD`. */
  day: string;
  saleCount: number;
  /** Units sold, all categories. */
  itemsSold: number;
  /** Units of `bag` sold. */
  bagsSold: number;
  /** Units of `shoe` sold. */
  shoesSold: number;
  grossKes: number;
  byPaymentMethod: Record<PosPaymentMethod, { count: number; gross: number }>;
  pendingSync: number;
}

export async function getDailyTotals(now = new Date()): Promise<DailyTotals> {
  const db = getDb();
  const { start, end } = eatDayRange(now);

  const sales = await db.pos_sales
    .where("createdAt")
    .between(start.toISOString(), end.toISOString(), true, false)
    .toArray();

  const byPaymentMethod: Record<
    PosPaymentMethod,
    { count: number; gross: number }
  > = {
    cash: { count: 0, gross: 0 },
    mpesa: { count: 0, gross: 0 },
    card: { count: 0, gross: 0 },
  };

  // Read once and only if a line is missing its own category: sales recorded
  // before the till carried `category` on the line fall back to the catalogue.
  const categories = sales.some((sale) =>
    sale.items.some((item) => item.category === null && item.productId !== null),
  )
    ? await categoryByProduct()
    : null;

  let grossKes = 0;
  let itemsSold = 0;
  let bagsSold = 0;
  let shoesSold = 0;

  for (const sale of sales) {
    grossKes += sale.totalKes;
    byPaymentMethod[sale.paymentMethod].count += 1;
    byPaymentMethod[sale.paymentMethod].gross += sale.totalKes;

    for (const item of sale.items) {
      itemsSold += item.quantity;
      const category =
        item.category ??
        (item.productId !== null
          ? (categories?.get(item.productId) ?? null)
          : null);
      if (category === "bag") bagsSold += item.quantity;
      else if (category === "shoe") shoesSold += item.quantity;
    }
  }

  const pendingSync = sales.filter((sale) => sale.syncedAt === null).length;

  return {
    day: eatDayKey(now),
    saleCount: sales.length,
    itemsSold,
    bagsSold,
    shoesSold,
    grossKes,
    byPaymentMethod,
    pendingSync,
  };
}

/** Product id → category, for the fallback above and nothing else. */
async function categoryByProduct(): Promise<Map<string, string>> {
  const products = await getDb().products.toArray();
  return new Map(products.map((product) => [product.id, product.category]));
}

/** Most recent sales, newest first. For the manager's list. */
export async function getRecentSales(limit = 10): Promise<LocalSale[]> {
  const db = getDb();
  return db.pos_sales.orderBy("createdAt").reverse().limit(limit).toArray();
}
