import Dexie, { type EntityTable } from "dexie";

import type { PosRole } from "@/lib/auth";

/**
 * The till's local database.
 *
 * Everything the POS needs to make a sale lives here, because the network is
 * the unreliable part. Supabase is the record of what *has* happened; this is
 * the record of what the cashier is doing right now, and it never blocks on a
 * round trip.
 *
 * Five tables, keyed for the access patterns that matter:
 *
 *   products      — the catalogue, keyed by the Supabase uuid.
 *   pos_sales     — sales, keyed by `clientUuid`, which is also the idempotency
 *                   key the sync upserts on.
 *   pos_users     — the staff roster, *including* the bcrypt hash, so a PIN can
 *                   be checked with no network. See the note in
 *                   012_pos.sql — this is a deliberate, documented tradeoff.
 *   sync_queue    — work owed to the server.
 *   till_sessions — cash-drawer shifts (added in v2): open float, close count
 *                   and the variance between them. Local-only.
 *
 * Sale lines are embedded in the sale rather than kept in their own table.
 * On the server they are normalised (`pos_sale_items`) because reporting wants
 * to query them; on the device nothing ever queries a line independently, and
 * embedding means a sale and its lines are written in one transaction that can
 * never half-fail.
 */

export type PosPaymentMethod = "cash" | "mpesa" | "card";

export interface LocalProduct {
  /** Supabase `products.id`. */
  id: string;
  name: string;
  slug: string;
  category: string;
  barcode: string | null;
  basePrice: number;
  discountPercent: number;
  /** The till's own count: already reduced by every sale, synced or not. */
  stockQuantity: number;
  active: boolean;
  /**
   * A URL for the product's first photograph, resolved from `product_images`
   * at sync time. Null when the product has no photography — the card then
   * draws its own placeholder rather than an empty frame.
   */
  imageUrl: string | null;
  /** When this row was last pulled from Supabase. */
  updatedAt: string;
}

export interface LocalPosUser {
  id: string;
  name: string;
  /** bcrypt. Never a PIN. See lib/auth.ts. */
  pinHash: string;
  role: PosRole;
  active: boolean;
  /** When this row was last pulled from Supabase. */
  updatedAt: string;
}

export interface LocalSaleItem {
  /** Client-generated uuid; becomes `pos_sale_items.id`. */
  id: string;
  productId: string | null;
  /** Denormalised: a receipt reprinted later must show the name as sold. */
  productName: string;
  /**
   * `bag` or `shoe` at the time of sale, so the manager's per-category figures
   * do not change if the product is recategorised or delisted later. Null on
   * sales recorded before the till started carrying it — reporting falls back
   * to the local catalogue for those.
   */
  category: string | null;
  quantity: number;
  priceAtSale: number;
}

export interface LocalSale {
  /** Primary key, and the server's idempotency key (`pos_sales.client_uuid`). */
  clientUuid: string;
  cashierId: string | null;
  cashierName: string;
  subtotalKes: number;
  discountKes: number;
  discountPercent: number;
  totalKes: number;
  paymentMethod: PosPaymentMethod;
  amountTendered: number | null;
  changeDue: number | null;
  /**
   * M-Pesa for `mpesa`, the card terminal's slip reference for `card`, null for
   * cash. One free-text column on the server (`pos_sales.mpesa_code`) because
   * both are "the code the cashier read off the machine" and nothing queries
   * them apart.
   */
  paymentReference: string | null;
  createdAt: string;
  /** Null until the sync lands. */
  syncedAt: string | null;
  items: LocalSaleItem[];
}

export type SyncQueueEntity = "sale" | "receipt_email";
export type SyncQueueStatus = "pending" | "error";

/**
 * A cash-drawer shift.
 *
 * Local-only for now: the pattern this app is built around is "write to the
 * device first", and a till session is no different. Nothing about opening a
 * drawer needs the network, so nothing about it blocks on one. Reconciling the
 * drawer to the server is a Phase 3 job.
 *
 * `expectedCash` and `variance` are stamped at close and kept, rather than
 * recomputed, so a manager reading a month later sees the shortage the cashier
 * was actually shown at the counter.
 */
export interface LocalTillSession {
  /** Auto-incrementing; a drawer shift is a log row, not an entity. */
  id?: number;
  openedAt: string;
  /** Name, not id: a deleted staff account must not blank a past shift. */
  openedBy: string;
  /** The float the drawer started with, in whole shillings. */
  openingFloat: number;
  closedAt: string | null;
  closedBy: string | null;
  /** Expected in the drawer at close: float + cash taken since open. */
  expectedCash: number | null;
  /** What the cashier counted. */
  countedCash: number | null;
  /** `counted − expected`: negative is short, positive is over. */
  variance: number | null;
}

export interface SyncQueueEntry {
  /** Auto-incrementing; the queue is a log, not an entity. */
  id?: number;
  entity: SyncQueueEntity;
  /** The `clientUuid` of the thing owed. */
  entityId: string;
  status: SyncQueueStatus;
  attempts: number;
  lastError: string | null;
  /** Extra arguments for the job — e.g. the receipt's email address. */
  payload: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

class PosDatabase extends Dexie {
  products!: EntityTable<LocalProduct, "id">;
  pos_sales!: EntityTable<LocalSale, "clientUuid">;
  pos_users!: EntityTable<LocalPosUser, "id">;
  sync_queue!: EntityTable<SyncQueueEntry, "id">;
  till_sessions!: EntityTable<LocalTillSession, "id">;

  constructor() {
    super("pedigree-pos");

    // Indexes are declared, not derived from the interface. Only what is
    // filtered or sorted on is indexed: every index is write cost on a device
    // that is busy taking money. `name` and `barcode` are indexed because both
    // the search box and the scanner look products up by them.
    this.version(1).stores({
      products: "id, name, slug, barcode, category, active, updatedAt",
      pos_sales: "clientUuid, createdAt, syncedAt, paymentMethod",
      pos_users: "id, role, active",
      sync_queue: "++id, entity, entityId, status, createdAt",
    });

    // v2 adds the cash drawer. Only the new table is named; Dexie carries the
    // rest forward from v1 untouched, so an existing till upgrades in place
    // with no migration step and no lost sales.
    this.version(2).stores({
      till_sessions: "++id, openedAt, closedAt",
    });
  }
}

/**
 * One connection per tab, created on first use.
 *
 * Lazy on purpose: this module is evaluated during the server render of every
 * client component that imports it, and `indexedDB` does not exist there.
 * Opening at import time would break the build; opening in an effect would mean
 * every caller racing to open. First call wins, the rest share it.
 */
let instance: PosDatabase | null = null;

export function getDb(): PosDatabase {
  if (instance === null) {
    instance = new PosDatabase();
  }
  return instance;
}

/** A uuid for a sale or a line. `crypto.randomUUID` needs a secure context —
 * localhost and HTTPS both qualify, which covers every till we ship to. */
export function newUuid(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
