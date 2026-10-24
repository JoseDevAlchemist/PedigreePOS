"use client";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isPosRole, type PosRole } from "@/lib/auth";
import {
  getDb,
  localReturnFromQueueEntry,
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
 *   2. `syncProducts`       — products created on the till.
 *   3. deferred sales       — retried now that their products exist.
 *   4. `syncReturns`        — returns, refunds and their stock corrections.
 *   5. `fetchProducts`      — the catalogue.
 *   6. `fetchPosUsers`      — the staff roster, so the next offline sign-in works.
 *   7. `syncReceiptEmails`  — queued receipts.
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
const PRODUCTS_WITH_IMAGES = `${PRODUCT_COLUMNS},product_colors(color_name,sort_order,product_images(angle,image_url,sort_order))`;

interface ProductImageRow {
  angle: string | null;
  image_url: string | null;
  sort_order: number | null;
}

interface ProductColorRow {
  color_name: string;
  sort_order: number | null;
  product_images: ProductImageRow[] | null;
}

/**
 * Colourway names in their merchandised order.
 *
 * The till used to ignore server colours entirely, so a storefront product's
 * colour list was blank and a POS-created product's local list was wiped on the
 * next pull. Both cases now read from the same place, with the local list kept
 * as the fallback when the server has no colours yet (the POS does not write
 * `product_colors`).
 */
function pickColors(colors: ProductColorRow[] | null): string[] {
  return [...(colors ?? [])]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((color) => color.color_name)
    .filter((name): name is string => typeof name === "string" && name.trim() !== "");
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
 * Units sold or returned on this till that the server has not yet been told
 * about, per product.
 *
 * Derived from local rows rather than stored, so it cannot drift out of step
 * with the sales and returns that produced it. Without it, `fetchProducts`
 * would overwrite locally-decremented stock with the server's higher figure and
 * silently un-sell goods the cashier has already handed over the counter.
 *
 * Returns come from the local ledger. A queue row from before v3 (or one whose
 * ledger backfill was interrupted) is still counted, so an upgrade cannot make
 * a returned unit disappear on the next catalogue pull.
 */
async function pendingStockByProduct(): Promise<Map<string, number>> {
  const db = getDb();
  const unsyncedSales = await db.pos_sales
    .filter((sale) => sale.syncedAt === null)
    .toArray();
  const allReturns = await db.local_returns.toArray();
  const ledgerIds = new Set(allReturns.map((record) => record.clientUuid));
  const orphanReturns = (
    await db.sync_queue.where("entity").equals("return").toArray()
  ).filter((entry) => !ledgerIds.has(entry.entityId));

  const byProduct = new Map<string, number>();
  for (const sale of unsyncedSales) {
    for (const item of sale.items) {
      if (item.productId === null) continue;
      byProduct.set(
        item.productId,
        (byProduct.get(item.productId) ?? 0) + item.quantity,
      );
    }
  }

  // Returns that have not reached the server yet put stock back on the shelf,
  // so they offset the pending sale decrements. A synced return is already in
  // the server's stock figure and must not be subtracted twice.
  for (const record of allReturns) {
    if (record.syncedAt !== null) continue;
    for (const item of record.items) {
      byProduct.set(
        item.productId,
        (byProduct.get(item.productId) ?? 0) - item.quantity,
      );
    }
  }
  for (const entry of orphanReturns) {
    const record = localReturnFromQueueEntry(entry);
    if (record === null) continue;
    for (const item of record.items) {
      byProduct.set(
        item.productId,
        (byProduct.get(item.productId) ?? 0) - item.quantity,
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
 *
 * A product with a queued create call is the exception to "the server is
 * authoritative": it is kept even when absent from the response, and its
 * till-only fields (image, colours) are merged over the server row. The same
 * fallback applies after the queue clears, because the POS does not upload
 * images or colours yet; otherwise a successful push would still erase them on
 * the next pull.
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
    db.local_returns,
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

      // A product with a queue entry has not necessarily reached the server.
      // It must not be deleted just because the server response does not list
      // it, and its local-only fields must survive the merge below.
      const pendingProductIds = new Set(
        (await db.sync_queue.where("entity").equals("product").toArray()).map(
          (entry) => entry.entityId,
        ),
      );

      const previousById = new Map<string, LocalProduct>();
      for (const product of await db.products.bulkGet(ids)) {
        if (product) previousById.set(product.id, product);
      }

      const local: LocalProduct[] = rows.map((row) => {
        const previous = previousById.get(row.id);
        const isPending = pendingProductIds.has(row.id);
        const serverColors = pickColors(row.product_colors);
        const pendingDelta = pending.get(row.id) ?? 0;

        return {
          id: row.id,
          name: row.name,
          slug: row.slug,
          category: row.category,
          barcode: row.barcode ?? null,
          basePrice: row.base_price,
          discountPercent: row.discount_percent,
          // A pending product's local count is the source of truth until its
          // create RPC lands. For a synced product, the server is authoritative
          // except for sales and returns this till has not pushed yet.
          stockQuantity: isPending
            ? (previous?.stockQuantity ??
              Math.max(0, row.stock_quantity - pendingDelta))
            : Math.max(0, row.stock_quantity - pendingDelta),
          active: row.active,
          // The server image wins when it exists; otherwise keep the resized
          // local image. POS-created images are intentionally till-only until
          // a signed upload path exists.
          imageUrl: pickImageUrl(row.product_colors) ?? previous?.imageUrl ?? null,
          updatedAt,
          // Colours are now read from the server when present. The POS RPC does
          // not write product_colors, so a locally chosen list is the fallback.
          colors: serverColors.length > 0 ? serverColors : (previous?.colors ?? []),
          isWebsitePublished: isPending
            ? (previous?.isWebsitePublished ?? row.is_website_published ?? false)
            : (row.is_website_published ?? false),
        };
      });

      await db.products.bulkPut(local);

      // Keep local products whose create call is still queued. Without this,
      // a product created offline disappears on the next catalogue refresh.
      const deletable =
        ids.length === 0
          ? await db.products.toCollection().primaryKeys()
          : await db.products.where("id").noneOf(ids).primaryKeys();
      const toDelete = deletable.filter((id) => !pendingProductIds.has(id));
      if (toDelete.length > 0) await db.products.bulkDelete(toDelete);
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
 * `pos_create_product` is the only way in: `products` has no INSERT policy for
 * anon, so a direct upsert fails with RLS. The function is insert-only and
 * idempotent on the client-generated id, which is what makes a retry after a
 * timeout safe. It does not touch `base_price_usd`, so a USD price set in the
 * admin is never nulled by a POS push.
 *
 * The image and colourways are local-only for now. They live in IndexedDB and
 * are never part of this call; the storefront still gets the product row.
 *
 * `pendingStockDelta` is the net unsynced sale/return quantity for this
 * product. It reconstructs the stock the server should be born with: the local
 * row has already been decremented/incremented by those events, and they will
 * be applied to the server later, so adding the delta keeps the two in step
 * after they sync. Without it, a sale made before the product reaches the
 * server is counted twice.
 */
async function pushProduct(
  supabase: SupabaseClient<Database>,
  product: LocalProduct,
  pendingStockDelta: number,
): Promise<void> {
  const stockAtServerCreation = Math.max(
    0,
    product.stockQuantity + pendingStockDelta,
  );

  const { error } = await supabase.rpc("pos_create_product", {
    p_id: product.id,
    p_name: product.name,
    p_slug: product.slug,
    p_category: product.category,
    p_barcode: product.barcode,
    p_base_price: product.basePrice,
    p_discount_percent: product.discountPercent,
    p_stock_quantity: stockAtServerCreation,
    p_is_website_published: product.isWebsitePublished,
  });

  // A false result means the row already exists: this is a replay, not a
  // failure. Both outcomes mean the server has the product.
  if (error) {
    throw new SyncError(`Product ${product.name}: ${error.message}`);
  }
}

/**
 * Push every queued product.
 *
 * The queue entries, the live product rows and the pending stock snapshot are
 * read in one Dexie transaction. A sale that commits before that read is
 * included in both the local stock and the delta; one that commits after it is
 * not included in either and will be applied to the server later. Reading them
 * separately would let a sale slip between the two reads and be counted twice.
 */
export async function syncProducts(): Promise<{
  synced: number;
  failed: number;
}> {
  const supabase = requireClient();
  const db = getDb();

  const snapshot = await db.transaction(
    "r",
    db.products,
    db.pos_sales,
    db.local_returns,
    db.sync_queue,
    async () => {
      const entries = await db.sync_queue
        .where("entity")
        .equals("product")
        .toArray();
      const products = await db.products.bulkGet(
        entries.map((entry) => entry.entityId),
      );
      const pending = await pendingStockByProduct();
      return { entries, products, pending };
    },
  );

  let synced = 0;
  let failed = 0;

  for (let index = 0; index < snapshot.entries.length; index += 1) {
    const entry = snapshot.entries[index];
    const product = snapshot.products[index];

    // The product is gone, or already landed. Either way the queue entry is stale.
    if (!product) {
      if (entry.id !== undefined) await db.sync_queue.delete(entry.id);
      continue;
    }

    try {
      await pushProduct(
        supabase,
        product,
        snapshot.pending.get(product.id) ?? 0,
      );
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
    p_original_sale_id: asUuidOrNull(payload.original_sale_id),
    p_cashier_id: asUuidOrNull(payload.cashier_id),
    p_cashier_name: asString(payload.cashier_name),
    p_manager_id: asUuidOrNull(payload.manager_id),
    p_manager_name: asString(payload.manager_name),
    p_items: (Array.isArray(payload.items) ? payload.items : []) as unknown as Json,
    p_refund_kes: asNonNegativeInteger(payload.refund_kes),
    p_refund_method: asRefundMethod(payload.refund_method),
    p_refund_reference: asNullableText(payload.refund_reference),
  });

  if (error) {
    throw new SyncError(`Return ${entry.entityId}: ${error.message}`);
  }
}

/**
 * Keep the ledger row after its queue entry is gone.
 *
 * The server has accepted the return, so `syncedAt` is stamped in the same
 * transaction that deletes the queue row. If the ledger is somehow missing
 * (an upgrade that raced an old tab, for example), rebuild it from the payload
 * first so the audit trail is not thrown away with the queue row.
 */
async function markReturnSynced(entry: SyncQueueEntry): Promise<void> {
  const db = getDb();
  const syncedAt = nowIso();

  await db.transaction("rw", db.local_returns, db.sync_queue, async () => {
    const existing = await db.local_returns.get(entry.entityId);
    if (existing === undefined) {
      const rebuilt = localReturnFromQueueEntry(entry);
      if (rebuilt !== null) {
        await db.local_returns.put({ ...rebuilt, syncedAt });
      }
    } else {
      await db.local_returns.update(entry.entityId, { syncedAt });
    }

    if (entry.id !== undefined) await db.sync_queue.delete(entry.id);
  });
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
      await markReturnSynced(entry);
      synced += 1;
    } catch (error) {
      await recordFailure(entry, error);
      failed += 1;
    }
  }

  return { synced, failed };
}

/** A blank or non-string id must become NULL, never the string "". */
function asUuidOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function asNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function asRefundMethod(
  value: unknown,
): "cash" | "mpesa" | "card" | null {
  return value === "cash" || value === "mpesa" || value === "card"
    ? value
    : null;
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
 *
 * A sale that references a product whose create call is still queued is
 * *deferred*, not failed: its foreign key cannot exist on the server yet.
 * `runSync` retries the returned ids after `syncProducts` in the same pass, so a
 * product created and sold offline does not raise a false money alarm.
 */
export async function syncSales(options: {
  skipProductIds?: Set<string>;
  onlySaleIds?: Set<string>;
} = {}): Promise<{
  synced: number;
  failed: number;
  deferred: string[];
}> {
  const supabase = requireClient();
  const db = getDb();

  const entries = await db.sync_queue.where("entity").equals("sale").toArray();
  const skipProductIds = options.skipProductIds ?? new Set<string>();
  let synced = 0;
  let failed = 0;
  const deferred: string[] = [];

  for (const entry of entries) {
    if (options.onlySaleIds && !options.onlySaleIds.has(entry.entityId)) {
      continue;
    }

    const sale = await db.pos_sales.get(entry.entityId);

    // The sale is gone, or already landed. Either way the queue entry is stale.
    if (!sale || sale.syncedAt !== null) {
      if (entry.id !== undefined) await db.sync_queue.delete(entry.id);
      continue;
    }

    if (
      sale.items.some(
        (item) => item.productId !== null && skipProductIds.has(item.productId),
      )
    ) {
      deferred.push(entry.entityId);
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

  return { synced, failed, deferred };
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
  let deferredSaleIds: string[] = [];
  let productSyncFinished = false;

  if (isSupabaseConfigured()) {
    // Money first. A sale for a product that has not reached the server yet
    // cannot satisfy its foreign key, so defer it and retry after
    // `syncProducts` below instead of recording a false failure.
    const db = getDb();
    const pendingProductIds = new Set<string>();
    try {
      for (const entry of await db.sync_queue
        .where("entity")
        .equals("product")
        .toArray()) {
        pendingProductIds.add(entry.entityId);
      }
    } catch (error) {
      notices.push(messageOf(error));
    }

    try {
      const result = await syncSales({ skipProductIds: pendingProductIds });
      syncedSales = result.synced;
      failedSales = result.failed;
      deferredSaleIds = result.deferred;
      if (result.failed > 0) {
        errors.push(`${result.failed} sale(s) could not be sent.`);
      }
    } catch (error) {
      errors.push(messageOf(error));
    }

    // Products first: a return can reference a product that was created
    // offline. If the product is not on the server yet, the return line is
    // recorded with `product_id = NULL` and the server cannot restock it.
    try {
      const result = await syncProducts();
      productSyncFinished = true;
      if (result.failed > 0) {
        notices.push(`${result.failed} product(s) could not be sent.`);
      }
    } catch (error) {
      notices.push(messageOf(error));
    }

    // The products those deferred sales needed now exist (or the push failed,
    // in which case this attempt is a real failure). Retry only the deferred
    // sales so unrelated failures are not counted twice in one pass. This runs
    // before returns so a return can resolve its original sale as well as its
    // product, which keeps the server-side over-return check meaningful.
    if (productSyncFinished && deferredSaleIds.length > 0) {
      try {
        const result = await syncSales({
          onlySaleIds: new Set(deferredSaleIds),
        });
        syncedSales += result.synced;
        failedSales += result.failed;
        if (result.failed > 0) {
          errors.push(`${result.failed} sale(s) could not be sent.`);
        }
      } catch (error) {
        errors.push(messageOf(error));
      }
    }

    // Stock corrections go up before the catalogue is refreshed, so a pull
    // never overwrites a local change.
    try {
      const result = await syncReturns();
      if (result.failed > 0) {
        notices.push(`${result.failed} return(s) could not be sent.`);
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
