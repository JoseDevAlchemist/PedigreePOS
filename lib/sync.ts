"use client";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isPosRole, type PosRole } from "@/lib/auth";
import {
  getDb,
  nowIso,
  type LocalProduct,
  type LocalSale,
  type SyncQueueEntity,
  type SyncQueueEntry,
} from "@/lib/db";
import { createClient, getSupabaseConfig, isSupabaseConfigured } from "@/lib/supabase/client";
import type { Database, Json } from "@/lib/supabase/types";

/**
 * Sync between the till and Supabase.
 *
 * The rule that shapes everything here: **the network is optional.** Every
 * function either reads or writes IndexedDB and treats Supabase as a
 * best-effort mirror. Nothing awaits the network to let a cashier take money,
 * and every push is idempotent so a retry after a timeout is safe.
 *
 * ## Ordering
 *
 * Push before pull. If a sync run is interrupted, the money that has already
 * been taken matters more than the catalogue being a minute fresher.
 *
 *   1. `syncSales`          — sales and their stock decrements.
 *   2. `syncReceiptEmails`  — queued receipts.
 *   3. `fetchProducts`      — the catalogue.
 *   4. `fetchPosUsers`      — the staff roster, so the next offline sign-in works.
 *
 * ## Idempotency
 *
 * A sale is recorded by a single `pos_record_sale` call that inserts with
 * `ON CONFLICT (client_uuid) DO NOTHING`, so replaying a sale that already
 * landed is a no-op rather than a duplicate row, and the stock decrement is
 * stamped server-side the first time it runs. Retrying is therefore free.
 * `supabase/migrations/014_pos_record_sale.sql` explains why this is a function
 * rather than a client-side upsert.
 */

/** How often to try again while online, in ms. The `online` event covers the
 * usual case; this catches a connection that flaps without firing it. */
const SYNC_INTERVAL_MS = 60_000;

export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}

export interface SyncState {
  /**
   * False until the client has read `navigator.onLine`. On the server, and on
   * the first client render, there is no connectivity to report — without this
   * the header would flash "Online" on an offline till before the effect ran.
   */
  hydrated: boolean;
  /** `navigator.onLine`. */
  online: boolean;
  syncing: boolean;
  /** Everything owed to the server, sales and receipts alike. */
  pending: number;
  lastSyncedAt: string | null;
  /**
   * The first error from the last run that concerns **money** — a sale the
   * server refused, or could not be reached. This is what turns the header
   * light red.
   */
  lastError: string | null;
  /**
   * The first error that does *not* concern money: a catalogue or roster that
   * could not be refreshed, a receipt that could not be emailed.
   *
   * Kept apart from `lastError` on purpose. Receipt email is unconfigured until
   * a provider is wired up, so every queued receipt would otherwise leave the
   * till showing a red light all day while every shilling had in fact synced —
   * and a light that is always red is a light nobody reads.
   */
  lastNotice: string | null;
  /** False when `.env.local` has no Supabase credentials: the till runs offline-only. */
  configured: boolean;
}

export interface SyncSummary {
  syncedSales: number;
  failedSales: number;
  products: number;
  users: number;
  emails: number;
  pending: number;
  errors: string[];
}

/* ---------------------------------------------------------------------------
   A tiny external store.

   The sync state is read by the header and by the manager dashboard, and it
   changes from outside React (event listeners, timers). `useSyncExternalStore`
   wants a subscribe function and a snapshot that is referentially stable while
   nothing has changed, so the state object is only replaced when a field
   actually differs.
   --------------------------------------------------------------------------- */

const initialState: SyncState = {
  hydrated: false,
  online: true,
  syncing: false,
  pending: 0,
  lastSyncedAt: null,
  lastError: null,
  lastNotice: null,
  configured: isSupabaseConfigured(),
};

let state: SyncState = initialState;
const listeners = new Set<() => void>();

export function subscribeSyncState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSyncState(): SyncState {
  return state;
}

function setState(patch: Partial<SyncState>): void {
  let changed = false;
  for (const key of Object.keys(patch) as (keyof SyncState)[]) {
    if (!Object.is(state[key], patch[key])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;

  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/* ---------------------------------------------------------------------------
   Reads
   --------------------------------------------------------------------------- */

function requireClient(): SupabaseClient<Database> {
  if (!isSupabaseConfigured()) {
    throw new SyncError(
      "Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local.",
    );
  }
  return createClient();
}

const PRODUCT_COLUMNS =
  "id,name,slug,category,barcode,base_price,discount_percent,stock_quantity,active,is_website_published";

/**
 * The catalogue query, with each product's photography folded in.
 *
 * `product_images` hangs off `product_colors`, not `products` — a product has
 * colourways, a colourway has angles — so the embed is two levels deep. The
 * public read policies on all three tables allow it under the anon key.
 *
 * The shape is asserted rather than generated: `lib/supabase/types.ts` is a
 * hand-written subset with no relationship metadata, and PostgREST's typed
 * parser needs that metadata to describe an embedded select. The select string
 * is the contract; `ProductRow` below is what it returns.
 */
const PRODUCTS_WITH_IMAGES = `${PRODUCT_COLUMNS},product_colors(sort_order,product_images(angle,image_url,sort_order))`;

interface ProductImageRow {
  angle: string | null;
  image_url: string | null;
  sort_order: number | null;
}

interface ProductColorRow {
  sort_order: number | null;
  product_images: ProductImageRow[] | null;
}

interface ProductRow {
  id: string;
  name: string;
  slug: string;
  category: string;
  barcode: string | null;
  base_price: number;
  discount_percent: number;
  stock_quantity: number;
  active: boolean;
  is_website_published: boolean;
  product_colors: ProductColorRow[] | null;
}

/**
 * The first usable photograph for a product, or null.
 *
 * "First" is ordered, not arbitrary: colourways in their merchandised order,
 * photographs in theirs, and a `front` shot preferred over the rest because it
 * is the one the storefront leads with. A card is 128px tall; the front view is
 * the one that reads at that size.
 */
function pickImageUrl(colors: ProductColorRow[] | null): string | null {
  const ordered = [...(colors ?? [])].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
  );

  const candidates: ProductImageRow[] = [];
  for (const color of ordered) {
    const images = [...(color.product_images ?? [])].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
    );
    for (const image of images) {
      if (typeof image.image_url === "string" && image.image_url.trim() !== "") {
        candidates.push(image);
      }
    }
  }

  if (candidates.length === 0) return null;
  const front = candidates.find((image) => image.angle === "front");
  return normalizeImageUrl((front ?? candidates[0]).image_url);
}

/**
 * An absolute URL, or a bucket-relative path turned into one.
 *
 * The storefront stores full public URLs, which is the common case. Some
 * environments store the object path instead, so it is resolved against the
 * configured project rather than left to render as a broken relative `src`.
 */
function normalizeImageUrl(raw: string | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;

  const config = getSupabaseConfig();
  if (config === null) return null;
  const path = value.replace(/^\/+/, "").replace(/^product-images\//, "");
  return `${config.url.replace(/\/+$/, "")}/storage/v1/object/public/product-images/${path}`;
}

/**
 * Units sold on this till that the server has not yet been told about, per
 * product.
 *
 * Derived from the queue rather than stored, so it cannot drift out of step
 * with the sales that produced it. Without it, `fetchProducts` would overwrite
 * locally-decremented stock with the server's higher figure and silently
 * un-sell goods the cashier has already handed over the counter.
 */
async function pendingStockByProduct(): Promise<Map<string, number>> {
  const db = getDb();
  const unsynced = await db.pos_sales.filter((sale) => sale.syncedAt === null).toArray();
  // Returns that have not reached the server yet put stock back on the shelf,
  // so they offset the pending sale decrements. Without this, a catalogue pull
  // would reset a locally-returned product's stock back down until the return
  // itself syncs.
  const unsyncedReturns = await db.sync_queue
    .where("entity")
    .equals("return")
    .toArray();

  const byProduct = new Map<string, number>();
  for (const sale of unsynced) {
    for (const item of sale.items) {
      if (item.productId === null) continue;
      byProduct.set(
        item.productId,
        (byProduct.get(item.productId) ?? 0) + item.quantity,
      );
    }
  }
  for (const entry of unsyncedReturns) {
    const items = (entry.payload?.items as
      | { product_id: string; quantity: number }[]
      | undefined) ?? [];
    for (const item of items) {
      if (!item.product_id) continue;
      byProduct.set(
        item.product_id,
        (byProduct.get(item.product_id) ?? 0) - item.quantity,
      );
    }
  }
  return byProduct;
}

/**
 * Pull the active catalogue into the local database.
 *
 * Stock is written as `server − pending`, not as `server`. Inactive products
 * are removed: `active = false` means "not for sale", so it has no place on a
 * till. A product that comes back is re-fetched; nothing is lost.
 */
export async function fetchProducts(): Promise<number> {
  const supabase = requireClient();

  const { data, error } = await supabase
    .from("products")
    .select(PRODUCTS_WITH_IMAGES)
    .eq("active", true);

  if (error) throw new SyncError(`Could not fetch products: ${error.message}`);

  const rows = (data ?? []) as unknown as ProductRow[];
  const updatedAt = nowIso();
  const ids = rows.map((row) => row.id);

  const db = getDb();
  await db.transaction(
    "rw",
    db.products,
    db.pos_sales,
    db.sync_queue,
    async () => {
      // An empty response is far more likely to be an RLS/configuration failure
      // than a shop with no catalogue. Never let that wipe a working till.
      if (rows.length === 0 && (await db.products.count()) > 0) {
        const message =
          "Catalogue refresh returned no products; keeping the local catalogue.";
        setState({ lastNotice: message });
        console.warn(message);
        throw new SyncError(message);
      }

      // Read pending work inside the same transaction as the write. A return
      // that commits before this point is included in the delta; one that
      // arrives after it waits for the pull and then increments the fresh
      // stock, instead of being overwritten.
      const pending = await pendingStockByProduct();
      const local: LocalProduct[] = rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        category: row.category,
        barcode: row.barcode ?? null,
        basePrice: row.base_price,
        discountPercent: row.discount_percent,
        stockQuantity: Math.max(
          0,
          row.stock_quantity - (pending.get(row.id) ?? 0),
        ),
        active: row.active,
        imageUrl: pickImageUrl(row.product_colors),
        updatedAt,
        // The local catalogue doesn't carry colour names yet; they are captured
        // when a manager adds a product from the till.
        colors: [],
        isWebsitePublished: row.is_website_published ?? false,
      }));

      await db.products.bulkPut(local);

      if (ids.length === 0) {
        await db.products.clear();
      } else {
        await db.products.where("id").noneOf(ids).delete();
      }
    },
  );

  return rows.length;
}

/**
 * Pull the staff roster, hashes and all.
 *
 * The roster is cached so a PIN can be checked with no network — see the
 * tradeoff documented in `supabase/migrations/012_pos.sql`. Only active staff
 * are kept; the array is authoritative, so anyone no longer returned loses
 * their local record and with it the ability to sign in.
 */
export async function fetchPosUsers(): Promise<number> {
  const supabase = requireClient();

  const { data, error } = await supabase
    .from("pos_users")
    .select("id,name,pin_hash,role,active")
    .eq("active", true);

  if (error) throw new SyncError(`Could not fetch staff: ${error.message}`);

  const rows = (data ?? []).filter((row) => isPosRole(row.role));
  const updatedAt = nowIso();
  const ids = rows.map((row) => row.id);

  const db = getDb();
  await db.transaction("rw", db.pos_users, async () => {
    await db.pos_users.bulkPut(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        pinHash: row.pin_hash,
        role: row.role as PosRole,
        active: row.active,
        updatedAt,
      })),
    );

    if (ids.length === 0) {
      await db.pos_users.clear();
    } else {
      await db.pos_users.where("id").noneOf(ids).delete();
    }
  });

  return rows.length;
}

/* ---------------------------------------------------------------------------
   Pushes
   --------------------------------------------------------------------------- */

/**
 * Send one sale: the sale, its lines and its stock decrement, in a single call.
 *
 * `pos_record_sale` is the till's only way in. `anon` has no access to
 * `pos_sales` or `pos_sale_items` at all — see `supabase/migrations/014` for
 * why a client-side `upsert(..., { ignoreDuplicates: true })` cannot work
 * against a table the caller may not read, and what replaced it.
 *
 * One call rather than three, because three round trips could die in the middle
 * and leave a sale with no lines, and so no stock decrement, until the next
 * sync repaired it. Now the whole thing is one transaction.
 *
 * Idempotency is unchanged and still keyed on the uuid minted at the till: the
 * function inserts with `ON CONFLICT (client_uuid) DO NOTHING` and its stock
 * decrement is guarded by `stock_applied_at`, so a replay after a timeout that
 * actually succeeded is a no-op. Retrying is free, at any point, from any till.
 */
async function pushSale(
  supabase: SupabaseClient<Database>,
  sale: LocalSale,
): Promise<void> {
  const { error } = await supabase.rpc("pos_record_sale", {
    // One uuid, sent as both the primary key and the idempotency key, so the
    // lines below can point at the sale with no read-back to learn its id.
    p_client_uuid: sale.clientUuid,
    p_cashier_id: sale.cashierId,
    p_cashier_name: sale.cashierName,
    p_subtotal_kes: sale.subtotalKes,
    p_discount_kes: sale.discountKes,
    p_discount_percent: sale.discountPercent,
    p_total_kes: sale.totalKes,
    p_payment_method: sale.paymentMethod,
    p_amount_tendered: sale.amountTendered,
    p_change_due: sale.changeDue,
    p_mpesa_code: sale.paymentReference,
    p_created_at: sale.createdAt,
    p_items: sale.items.map((item) => ({
      id: item.id,
      product_id: item.productId,
      product_name: item.productName,
      quantity: item.quantity,
      price_at_sale: item.priceAtSale,
    })),
  });

  // The function answers `true` for "recorded" and `false` for "already there".
  // Both mean the server has it and the till is done with it, so neither is an
  // error and the distinction is deliberately not carried any further.
  if (error) {
    throw new SyncError(`Sale ${sale.clientUuid}: ${error.message}`);
  }
}

/**
 * Push one queued product to the catalogue.
 *
 * Upserts on the product's id, so a product created on the till and then
 * re-synced is updated in place rather than duplicated. The image and colours
 * live in separate tables this till does not write, so only the product row
 * itself is pushed here; `is_website_published` is included so a product a
 * manager explicitly published can go live, and defaults to false so a new
 * product never accidentally reaches the storefront.
 */
async function pushProduct(
  supabase: SupabaseClient<Database>,
  product: LocalProduct,
): Promise<void> {
  const { error } = await supabase.from("products").upsert(
    {
      id: product.id,
      name: product.name,
      slug: product.slug,
      category: product.category,
      barcode: product.barcode,
      base_price: product.basePrice,
      base_price_usd: null,
      discount_percent: product.discountPercent,
      stock_quantity: product.stockQuantity,
      active: product.active,
      is_website_published: product.isWebsitePublished,
    },
    { onConflict: "id" },
  );

  if (error) {
    throw new SyncError(`Product ${product.name}: ${error.message}`);
  }
}

/**
 * Push every queued product.
 */
export async function syncProducts(): Promise<{
  synced: number;
  failed: number;
}> {
  const supabase = requireClient();
  const db = getDb();

  const entries = await db.sync_queue.where("entity").equals("product").toArray();
  let synced = 0;
  let failed = 0;

  for (const entry of entries) {
    const product = await db.products.get(entry.entityId);

    // The product is gone, or already landed. Either way the queue entry is stale.
    if (!product) {
      if (entry.id !== undefined) await db.sync_queue.delete(entry.id);
      continue;
    }

    try {
      await pushProduct(supabase, product);
      if (entry.id !== undefined) await db.sync_queue.delete(entry.id);
      synced += 1;
    } catch (error) {
      await recordFailure(entry, error);
      failed += 1;
    }
  }

  return { synced, failed };
}

/**
 * Push one queued return. A return reverses a sale's stock decrement on the
 * server: it records the return and re-increments the affected products.
 */
async function pushReturn(
  supabase: SupabaseClient<Database>,
  entry: SyncQueueEntry,
): Promise<void> {
  // The queue payload is untyped (`Record<string, unknown>`), so each field is
  // cast to the shape `recordReturn` wrote. The keys match the snake_case
  // payload that lib/returns.ts stores.
  const payload = (entry.payload ?? {}) as Record<string, unknown>;
  const { error } = await supabase.rpc("pos_record_return", {
    p_client_uuid: entry.entityId,
    p_original_sale_id: (payload.original_sale_id as string) ?? null,
    p_cashier_id: (payload.cashier_id as string) ?? null,
    p_cashier_name: (payload.cashier_name as string) ?? "",
    p_manager_id: (payload.manager_id as string) ?? null,
    p_manager_name: (payload.manager_name as string) ?? "",
    p_items: (payload.items ?? []) as unknown as Json,
  });

  if (error) {
    throw new SyncError(`Return ${entry.entityId}: ${error.message}`);
  }
}

/**
 * Push every queued return.
 */
export async function syncReturns(): Promise<{
  synced: number;
  failed: number;
}> {
  const supabase = requireClient();
  const db = getDb();

  const entries = await db.sync_queue.where("entity").equals("return").toArray();
  let synced = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      await pushReturn(supabase, entry);
      if (entry.id !== undefined) await db.sync_queue.delete(entry.id);
      synced += 1;
    } catch (error) {
      await recordFailure(entry, error);
      failed += 1;
    }
  }

  return { synced, failed };
}

async function recordFailure(
  entry: SyncQueueEntry,
  error: unknown,
): Promise<void> {
  if (entry.id === undefined) return;
  const db = getDb();
  await db.sync_queue.update(entry.id, {
    status: "error",
    attempts: entry.attempts + 1,
    lastError: messageOf(error),
    updatedAt: nowIso(),
  });
}

/**
 * Push every queued sale.
 *
 * Failures are recorded on the queue entry and the loop continues: one bad sale
 * must not hold up the rest of the day's takings.
 */
export async function syncSales(): Promise<{
  synced: number;
  failed: number;
}> {
  const supabase = requireClient();
  const db = getDb();

  const entries = await db.sync_queue.where("entity").equals("sale").toArray();
  let synced = 0;
  let failed = 0;

  for (const entry of entries) {
    const sale = await db.pos_sales.get(entry.entityId);

    // The sale is gone, or already landed. Either way the queue entry is stale.
    if (!sale || sale.syncedAt !== null) {
      if (entry.id !== undefined) await db.sync_queue.delete(entry.id);
      continue;
    }

    try {
      await pushSale(supabase, sale);
      await db.pos_sales.update(sale.clientUuid, { syncedAt: nowIso() });
      if (entry.id !== undefined) await db.sync_queue.delete(entry.id);
      synced += 1;
    } catch (error) {
      await recordFailure(entry, error);
      failed += 1;
    }
  }

  return { synced, failed };
}

/**
 * Deliver receipts that were queued while the shop had no connection.
 *
 * The till posts to its own server (`/api/pos/receipt-email`) rather than
 * talking to an email provider directly, so the provider's credentials never
 * reach the browser. Until that endpoint is wired to a provider it answers 501,
 * and the receipt stays queued with a visible error instead of vanishing.
 */
export async function syncReceiptEmails(): Promise<{
  sent: number;
  failed: number;
}> {
  const db = getDb();
  const entries = await db.sync_queue
    .where("entity")
    .equals("receipt_email")
    .toArray();

  let sent = 0;
  let failed = 0;

  for (const entry of entries) {
    const email = entry.payload?.email;
    if (typeof email !== "string" || email.length === 0) {
      if (entry.id !== undefined) await db.sync_queue.delete(entry.id);
      continue;
    }

    try {
      const response = await fetch("/api/pos/receipt-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientUuid: entry.entityId, email }),
      });

      if (!response.ok) {
        throw new SyncError(
          `Receipt email rejected (${response.status}).`,
        );
      }

      if (entry.id !== undefined) await db.sync_queue.delete(entry.id);
      sent += 1;
    } catch (error) {
      await recordFailure(entry, error);
      failed += 1;
    }
  }

  return { sent, failed };
}

/* ---------------------------------------------------------------------------
   Orchestration
   --------------------------------------------------------------------------- */

export async function countPending(): Promise<number> {
  const db = getDb();
  const pending = await db.sync_queue.count();
  setState({ pending });
  return pending;
}

/**
 * One full pass: push what is owed, then refresh what is cached.
 *
 * Each step is isolated. A catalogue fetch that times out must not stop the
 * day's sales from being pushed, so failures are collected and the run
 * continues rather than throwing on the first one.
 *
 * They are collected into two buckets, though. `errors` is money — sales that
 * did not reach the server — and it is what raises the alarm. `notices` is
 * everything else, which is worth showing a manager and not worth calling the
 * till broken over. All of them come back in `SyncSummary.errors` so a caller
 * that wants the whole picture still has it.
 */
export async function runSync(): Promise<SyncSummary> {
  if (state.syncing) {
    return {
      syncedSales: 0,
      failedSales: 0,
      products: 0,
      users: 0,
      emails: 0,
      pending: state.pending,
      errors: [],
    };
  }

  setState({ syncing: true });

  const errors: string[] = [];
  const notices: string[] = [];
  let syncedSales = 0;
  let failedSales = 0;
  let products = 0;
  let users = 0;
  let emails = 0;

  if (isSupabaseConfigured()) {
    // Money first.
    try {
      const result = await syncSales();
      syncedSales = result.synced;
      failedSales = result.failed;
      if (result.failed > 0) {
        errors.push(`${result.failed} sale(s) could not be sent.`);
      }
    } catch (error) {
      errors.push(messageOf(error));
    }

    // Stock corrections: returns and newly added products go up before the
    // catalogue is refreshed, so a pull never overwrites a local change.
    try {
      const result = await syncReturns();
      if (result.failed > 0) {
        notices.push(`${result.failed} return(s) could not be sent.`);
      }
    } catch (error) {
      notices.push(messageOf(error));
    }

    try {
      const result = await syncProducts();
      if (result.failed > 0) {
        notices.push(`${result.failed} product(s) could not be sent.`);
      }
    } catch (error) {
      notices.push(messageOf(error));
    }

    try {
      products = await fetchProducts();
    } catch (error) {
      notices.push(messageOf(error));
    }

    try {
      users = await fetchPosUsers();
    } catch (error) {
      notices.push(messageOf(error));
    }
  } else {
    // Not money either: with no credentials the till is *meant* to be local,
    // and the header already says so through `configured`.
    notices.push(
      "Supabase is not configured — the till is running offline only.",
    );
  }

  try {
    const result = await syncReceiptEmails();
    emails = result.sent;
    if (result.failed > 0) {
      notices.push(`${result.failed} receipt email(s) could not be sent.`);
    }
  } catch (error) {
    notices.push(messageOf(error));
  }

  const pending = await countPending();

  setState({
    syncing: false,
    pending,
    lastSyncedAt: nowIso(),
    lastError: errors[0] ?? null,
    lastNotice: notices[0] ?? null,
  });

  return {
    syncedSales,
    failedSales,
    products,
    users,
    emails,
    pending,
    errors: [...errors, ...notices],
  };
}

/**
 * Append a job to the sync queue and refresh the pending count.
 *
 * A small shared helper so sales, returns, products and receipt emails all
 * write the queue the same way.
 */
export async function addSyncQueueEntry(input: {
  entity: SyncQueueEntity;
  entityId: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}): Promise<void> {
  const db = getDb();
  const now = input.updatedAt;
  await db.sync_queue.add({
    entity: input.entity,
    entityId: input.entityId,
    status: "pending",
    attempts: 0,
    lastError: null,
    payload: input.payload,
    createdAt: input.createdAt,
    updatedAt: now,
  });
  await countPending();
}

/**
 * Wire up automatic syncing. Returns the teardown.
 *
 * Called once from a client effect. Syncs on mount, whenever the browser
 * reports it is back online, and on a slow interval to catch a connection that
 * flaps without firing `online`.
 */
export function startAutoSync(): () => void {
  if (typeof window === "undefined") return () => {};

  const goOnline = () => {
    setState({ online: true });
    void runSync().catch(() => {
      /* state already records the error */
    });
  };
  const goOffline = () => setState({ online: false });

  setState({ online: navigator.onLine, hydrated: true });

  // Paint the queue depth before the first network call so the header shows the
  // truth immediately, then sync if there is a connection.
  void countPending()
    .then(() => {
      if (navigator.onLine) {
        return runSync().catch(() => {});
      }
      return undefined;
    })
    .catch(() => {});

  window.addEventListener("online", goOnline);
  window.addEventListener("offline", goOffline);

  const interval = window.setInterval(() => {
    if (navigator.onLine && document.visibilityState === "visible") {
      void runSync().catch(() => {});
    }
  }, SYNC_INTERVAL_MS);

  return () => {
    window.removeEventListener("online", goOnline);
    window.removeEventListener("offline", goOffline);
    window.clearInterval(interval);
  };
}
