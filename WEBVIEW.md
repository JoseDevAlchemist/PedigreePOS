# WEBVIEW.md — Pedigree POS Architectural Blueprint

> **Status:** definitive architecture guide and implementation roadmap.
> **Baseline:** `main` at `49e671a`, plus the uncommitted returns/inventory work
> currently in the working tree (`lib/returns.ts`, `return-dialog.tsx`,
> `return-pin-dialog.tsx`, `product-form.tsx`, `app/manager/inventory/`, and
> `supabase/migrations/017_pos_returns.sql`).
> **Audience:** any engineer adding a feature to this till.
> **Rule:** this document describes the system as it is. Where code and comments
> disagree, the code wins, and the drift is called out explicitly.

---

## 0. The invariants

These are not preferences. Every feature in this document is judged against
them. Breaking one of these is how a till loses money, stock, or a cashier's
trust.

| # | Invariant | Why |
| --- | --- | --- |
| 1 | **No cashier action awaits the network.** | The shop must keep selling through an outage. IndexedDB writes are allowed; `fetch` is not. |
| 2 | **Local write + stock change + queue entry are one Dexie transaction.** | A crash must not leave a sale with no queue entry, or a queue entry with no sale. |
| 3 | **The local database is the truth for the current shift.** Supabase is a mirror. | The manager dashboard and the cart must show the same numbers offline and online. |
| 4 | **Every push is idempotent.** Sales and returns key on a client-generated UUID; products key on their UUID. | A retry after a timeout that actually succeeded must be free. |
| 5 | **Push before pull.** | Money already taken matters more than a fresher catalogue. |
| 6 | **A pull must never erase an unsynced local delta.** | A catalogue refresh that "un-sells" goods is the worst possible bug. |
| 7 | **Local navigation uses document requests, not the Next router.** | The service worker answers precached routes offline; a client-side navigation needs an RSC payload. |
| 8 | **Device APIs never run during render or on the server.** | `indexedDB`, `navigator.serial`, and `localStorage` do not exist in the Node render. |
| 9 | **No credential is ever logged.** | A PIN, a bcrypt hash, or a roster dump in DevTools is a leaked credential. |
| 10 | **Schema changes are additive and versioned.** | The till upgrades in place, with real sales on disk and no migration window. |

---

## 1. Codebase analysis

### 1.1 Runtime shape

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Chromium / installed PWA (desktop till)                            │
│                                                                     │
│  Next.js 16 App Router                                              │
│   ├─ server page shells (metadata, redirects, prefetchable HTML)    │
│   ├─ client screens ("use client")                                  │
│   ├─ Serwist service worker (app/sw.ts → public/sw.js)              │
│   └─ /api/pos/receipt-email (the only API route)                    │
│                                                                     │
│  Dexie / IndexedDB "pedigree-pos"                                  │
│   ├─ products        catalogue + local stock                        │
│   ├─ pos_sales       sales with embedded lines                      │
│   ├─ pos_users       staff roster + bcrypt hashes                   │
│   ├─ sync_queue      outbox owed to Supabase                        │
│   └─ till_sessions   cash-drawer shifts (local only)                │
│                                                                     │
│  React state                                                        │
│   ├─ cart            useReducer + lib/cart.ts                       │
│   ├─ catalogue       useLiveQuery(Dexie)                            │
│   ├─ sync state      useSyncExternalStore(lib/sync.ts)              │
│   └─ auth            useSyncExternalStore(localStorage)             │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ best effort, idempotent
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Shared Supabase project (storefront + POS)                          │
│  products / product_colors / product_images                         │
│  pos_users / pos_sales / pos_sale_items / pos_returns               │
│  RPCs: pos_record_sale, pos_record_return, pos_daily_totals         │
│  RLS: anon is deliberately narrow (see §4)                          │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 App Router and component boundaries

The project uses the Next.js 16 App Router with `cacheComponents: true` and
`partialPrefetching: true` (`next.config.ts`). Every route is a **server page**
that exports `metadata` and renders a **client screen**.

| Route | Server file | Client owner | Guard |
| --- | --- | --- | --- |
| `/` | `app/page.tsx` | none — `redirect("/pos")` | none |
| `/login` | `app/login/page.tsx` | `components/auth/pin-login.tsx` | redirects signed-in users to `/pos` |
| `/pos` | `app/pos/page.tsx` | `components/pos/pos-screen.tsx` | `RequireAuth` (any role) |
| `/manager` | `app/manager/page.tsx` | `components/manager/manager-dashboard.tsx` | `RequireAuth role="manager"` in `app/manager/layout.tsx` |
| `/manager/staff` | `app/manager/staff/page.tsx` | `components/manager/staff-manager.tsx` | inherited from manager layout |
| `/manager/inventory` | `app/manager/inventory/page.tsx` | `components/manager/product-form.tsx` | inherited from manager layout |
| `/~offline` | `app/~offline/page.tsx` | `components/offline-shell.tsx` | static fallback |
| `/api/pos/receipt-email` | `app/api/pos/receipt-email/route.ts` | — | none (see risks) |

Conventions:

- **Server pages are thin.** They export `metadata`, compose the guard, and
  render one client component. No device API is touched above the `"use client"`
  boundary.
- **Client components are named exports.** Use `export function Thing()` rather
  than default exports. Pages are the only default exports.
- **`"use client"` is the first line** of every file that uses hooks, Dexie,
  `localStorage`, `window`, or browser APIs.
- **Path alias `@/`** points at the repository root (`tsconfig.json`). Imports
  are absolute (`@/lib/db`), not relative climb-ups.
- **One concern per file.** `lib/` owns data and business rules; `components/`
  owns presentation and orchestration; `hooks/` owns reusable React glue.
- **Pure logic stays out of React.** `lib/cart.ts` is a pure reducer;
  `lib/sales.ts` owns total arithmetic; `lib/time.ts` owns EAT days. Keep new
  business rules in `lib/`, not inside a component.
- **No state-management library.** React local state, `useReducer`,
  `useLiveQuery`, and `useSyncExternalStore` cover the app. Do not add Redux,
  Zustand, or React Query.

### 1.3 Styling conventions

- **Tailwind CSS v4 via PostCSS** (`postcss.config.mjs`,
  `@tailwindcss/postcss`). The webpack build and the dev server share the same
  pipeline.
- **Design tokens live in `app/globals.css`.** Components use semantic classes
  (`bg-primary`, `text-muted`, `border-border`, `bg-danger-soft`) and never raw
  hex values. Brand primitives exist for the rare case that needs the hue.
- **`cn()`** from `lib/cn.ts` is the class-name merge helper. Use it for
  conditional classes; do not concatenate strings by hand.
- **Typography:** `font-serif` (Cormorant Garamond) for display and headings;
  `font-sans` (Manrope) for body. Money uses `tabular-nums`.
- **Accessibility is part of the style:** visible `focus-visible` rings,
  `aria-live` for changing totals and notices, `aria-pressed` for toggles,
  `aria-current="page"` for navigation, and `prefers-reduced-motion` handling in
  `components/ui/modal.tsx` and `components/pos/cart-panel.tsx`.
- **Motion:** Framer Motion for layout/enter/exit only, short (150–200ms), and
  skipped under reduced motion. Do not animate the serial display or the cart
  total in a way that hides a change.
- **Printing:** `app/globals.css` owns the 80mm `@page` rule and the
  `.print-root` rules. Never add print styles inline in a component.
- **Images:** the product grid uses a plain `<img>` on purpose, so the browser
  HTTP cache serves it offline. `next/image` is not used for remote product
  photography.

### 1.4 State ownership

| State | Owner | Mechanism | Lifetime |
| --- | --- | --- | --- |
| Cart lines, discount | `components/pos/pos-screen.tsx` | `useReducer(cartReducer)` | until clear/sale |
| Catalogue | `hooks/use-products.ts` | `useLiveQuery(getDb().products…)` | IndexedDB |
| Sync status/queue depth | `lib/sync.ts` + `hooks/use-sync-state.ts` | external store + `useSyncExternalStore` | tab |
| Auth session | `lib/auth.ts` + `components/auth-provider.tsx` | `localStorage` + external store | device |
| Checkout form | `components/pos/checkout-dialog.tsx` | local `useState` | dialog open |
| Manager PIN approval | `components/pos/return-pin-dialog.tsx` | local `useState` | dialog open |
| Till session | `lib/till.ts` | Dexie `till_sessions` | local only |
| Customer display (planned) | `lib/customer-display.ts` | external store + serial singleton | tab |

The pattern to copy for any new cross-component store is the one in
`lib/sync.ts`: a module-level snapshot, a `Set` of listeners, a `setState` that
only replaces the object when a field actually changes, and
`useSyncExternalStore` in a hook. Do not put device state in React context if it
changes outside React (serial events, timers, storage events).

### 1.5 Offline shell

- `app/sw.ts` builds `public/sw.js` through `@serwist/next`.
- The build **must** use `next dev --webpack` / `next build --webpack`; a
  Turbopack build silently produces no service worker.
- Every document request that misses the cache falls back to `/~offline`.
- Routes are linked with plain `<a href>`, and sign-in/sign-out/guard redirects
  use `window.location.replace`. This is deliberate; see invariant 7.
- The build revision is derived from `git rev-parse HEAD` in `next.config.ts`,
  so an offline till does not serve yesterday's shell forever.

---

## 2. Data flow and the sync engine

### 2.1 The outbox model

`sync_queue` is an **outbox**, not a job scheduler. A row means "this local fact
has not been acknowledged by Supabase yet". Success deletes the row. Failure
keeps it and stamps metadata.

```text
cashier action
    │
    ▼
Dexie transaction  ──► UI updates immediately (useLiveQuery)
    │   ├─ write the entity
    │   ├─ adjust local stock (if applicable)
    │   └─ add sync_queue row (pending)
    ▼
runSync()
    │
    ├─ push entity ──► Supabase RPC / upsert
    │       ├─ success ──► mark local entity synced (sales) / delete queue row
    │       └─ failure ──► status="error", attempts++, lastError
    │
    └─ pull catalogue/roster ──► Dexie, with pending deltas applied
```

Queue rows are **retried forever** until they succeed or the local entity is
gone. `syncSales`, `syncReturns`, and `syncProducts` select by `entity` only,
not by `status`, so an `"error"` row is picked up again on the next run.

### 2.2 `lib/sync.ts` in detail

#### The sync store

`SyncState` is a module-level object read through
`useSyncExternalStore`:

```ts
interface SyncState {
  hydrated: boolean;      // navigator.onLine has been read
  online: boolean;
  syncing: boolean;
  pending: number;        // every sync_queue row, including errors
  lastSyncedAt: string | null;
  lastError: string | null;   // money: a sale the server refused/unreachable
  lastNotice: string | null;  // non-money: catalogue, roster, receipt email
  configured: boolean;        // Supabase env vars present
}
```

`setState` compares each patched field with `Object.is` and only replaces the
snapshot when something changed. That keeps `useSyncExternalStore` from
re-rendering forever.

#### `runSync()` — the one full pass

`runSync()` is re-entrancy guarded by `state.syncing`. A second call while a run
is in flight returns zeroes immediately.

**Actual order in code** (`lib/sync.ts`):

```text
runSync()
├─ if (!isSupabaseConfigured()) ──► notice "offline only", skip to receipts
│
├─ 1. syncSales()          → pos_record_sale per queued sale
├─ 2. syncReturns()        → pos_record_return per queued return
├─ 3. syncProducts()       → products.upsert per queued product
├─ 4. fetchProducts()      → catalogue pull (active products)
├─ 5. fetchPosUsers()      → staff roster pull (active users)
│
├─ 6. syncReceiptEmails()  → POST /api/pos/receipt-email per queued email
│
└─ countPending(); setState({ syncing:false, pending, lastSyncedAt, … })
```

> **Documentation drift:** the header comment in `lib/sync.ts` says
> "sales → receipts → products → users". The code is
> **sales → returns → products → catalogue → roster → receipts**. The code is
> correct; the comment should be updated in the next sync change. The important
> invariant — money and stock corrections before the catalogue pull — holds.

Each step is wrapped in its own `try/catch`. A failed catalogue pull cannot stop
a sale from pushing. Errors are collected into two buckets:

- `errors` — money. Sale pushes that failed.
- `notices` — everything else. Returns, products, catalogue, roster, receipts.

`SyncSummary.errors` returns both buckets concatenated for callers that want the
whole picture, while `SyncState` keeps them separate so a red light only means
money is at risk.

#### `syncSales()`

For each `sync_queue` row with `entity = "sale"`:

1. Read the sale from `pos_sales` by `entityId`.
2. If the sale is missing or already has `syncedAt !== null`, delete the queue
   row as stale.
3. Call `pushSale(supabase, sale)`.
4. On success: `pos_sales.update(clientUuid, { syncedAt: nowIso() })`, then
   delete the queue row.
5. On failure: `recordFailure` → `status="error"`, `attempts+1`, `lastError`,
   `updatedAt`.

`pushSale` calls the RPC `pos_record_sale` with one argument per column and a
JSONB array of lines. The server function inserts the sale with
`ON CONFLICT (client_uuid) DO NOTHING`, inserts lines with
`ON CONFLICT (id) DO NOTHING`, then calls `pos_apply_sale_stock`, which is
guarded by `stock_applied_at`. A replay is a no-op.

The client does **not** inspect the boolean return value. `true` ("recorded")
and `false` ("already there") both mean the server has the sale.

#### `syncReturns()`

For each `sync_queue` row with `entity = "return"`:

1. Call `pushReturn(supabase, entry)`.
2. On success: delete the queue row. There is **no local return row** to stamp;
   the queue row was the only local record.
3. On failure: `recordFailure`.

`pushReturn` maps the snake_case payload written by `lib/returns.ts` onto
`pos_record_return`:

```ts
p_client_uuid       ← entry.entityId
p_original_sale_id  ← payload.original_sale_id
p_cashier_id        ← payload.cashier_id
p_cashier_name      ← payload.cashier_name
p_manager_id        ← payload.manager_id
p_manager_name      ← payload.manager_name
p_items             ← payload.items  // [{ product_id, product_name, quantity }]
```

The RPC inserts `pos_returns` with `ON CONFLICT (client_uuid) DO NOTHING`. If
the return already existed, it returns `false` and does **not** touch stock.
Otherwise it inserts `pos_return_items` and increments
`products.stock_quantity` for each product.

#### `syncProducts()`

For each `sync_queue` row with `entity = "product"`:

1. Read the live product from `products` by `entityId`.
2. If missing, delete the queue row as stale.
3. Call `pushProduct(supabase, product)`.
4. On success: delete the queue row.
5. On failure: `recordFailure`.

`pushProduct` currently performs a direct `products.upsert(..., { onConflict:
"id" })`. The queue payload is **not** used; the live product row is the source.
This matters for Feature C: the payload is documentation, not data.

> **Current blocker:** `products` has RLS enabled and only an `authenticated`
> write policy (`001_initial.sql`). The till uses the `anon` key with no
> Supabase auth session, so this upsert is rejected with
> `42501 new row violates row-level security policy`. See §7.4.

#### `fetchProducts()`

1. Select active products from Supabase, embedding
   `product_colors(sort_order, product_images(...))`.
2. Call `pendingStockByProduct()` to compute local-only deltas.
3. In a single Dexie transaction over `products`:
   - `bulkPut` the mapped catalogue with
     `stockQuantity = max(0, serverStock - pendingDelta)`.
   - Delete every local product whose id is not in the server response.
4. Return the number of rows.

Mapping details:

- `imageUrl` comes from the first usable `product_images` row, preferring
  `angle = "front"`, ordered by colour `sort_order` then image `sort_order`.
- `colors` is always written as `[]` on pull. Local colour names are not
  persisted server-side by the POS.
- `isWebsitePublished` is read from `products.is_website_published`.
- Inactive products disappear locally. A product that becomes active again is
  re-fetched; nothing is lost except local-only fields.
- There is **no pagination**. PostgREST caps a response (1,000 rows by default
  in Supabase). If the active catalogue ever exceeds that cap, every product
  outside the first page is absent from `ids` and is deleted locally as if it
  had been delisted. Add `.range()` paging (and delete only after the last
  page) before the catalogue approaches the cap.

#### `fetchPosUsers()`

1. Select active `pos_users` (id, name, `pin_hash`, role, active).
2. Filter rows whose role is not `cashier` or `manager`.
3. `bulkPut` into `pos_users`, delete any local user not returned.
4. Return the count.

Consequence: deactivating a user on the server removes their local row and
their ability to sign in on this till. The hash is intentionally cached so
offline sign-in works.

#### `syncReceiptEmails()`

For each `entity = "receipt_email"` row:

1. Read `payload.email`. If missing/empty, delete the row.
2. `POST /api/pos/receipt-email` with `{ clientUuid, email }`.
3. On `response.ok`, delete the row.
4. On failure, `recordFailure`.

The API route answers `501` until `POS_RECEIPT_EMAIL_WEBHOOK` is set, so the row
stays queued with a visible notice. There is **no server-side idempotency key**
for email delivery: a POST that times out after the provider accepted it can be
retried, producing a duplicate email.

#### `addSyncQueueEntry()`

A shared helper used by returns and products. It appends a row with:

```ts
{ entity, entityId, status: "pending", attempts: 0, lastError: null,
  payload, createdAt, updatedAt }
```

then calls `countPending()` so the header’s counter moves before the network is
touched.

> **Transaction caveat:** both `lib/returns.ts` and
> `components/manager/product-form.tsx` call `addSyncQueueEntry()` **inside** a
> Dexie transaction. That works because every awaited operation inside it is
> another Dexie request on `sync_queue`, but `countPending()` also synchronously
> notifies React listeners. Keep this helper’s post-commit side effects small;
> do not add a `fetch`, `await new Promise`, or a React state update that
> triggers asynchronous work inside the transaction. Dexie auto-commits when
> the request queue drains.

### 2.3 Offline behaviour

`startAutoSync()` (called by `<SyncProvider />`) does the following:

1. On mount, sets `online: navigator.onLine`, `hydrated: true`.
2. Calls `countPending()` to paint the queue depth.
3. If online, calls `runSync()` once.
4. Listens for `window` `online` / `offline`.
5. Every `SYNC_INTERVAL_MS` (60s), if online and the tab is visible, calls
   `runSync()` again.

Offline consequences:

| Feature | Offline behaviour |
| --- | --- |
| Sign in | Works from cached `pos_users` |
| Browse/search/scan | Works from cached `products` |
| Cart, discount, checkout | Local only |
| Complete sale | Dexie transaction; queue entry |
| Print receipt | `window.print()` |
| Queue receipt email | Queue entry; sends later |
| Manager dashboard | Local Dexie queries only |
| Cash drawer | Local `till_sessions` |
| Returns | Local stock increment + queue entry |
| Create product | Local row + queue entry (but see RLS blocker) |
| Push sales/returns/products | Retried when online |
| Refresh catalogue/roster | Fails safely; last cached copy remains |
| Deliver receipt email | Requires server + webhook |

`lastError` turns the header red only for money. `lastNotice` turns it amber for
non-money problems. `pending` counts every queue row, including `"error"` rows,
so an unsent receipt keeps the pill amber until it is resolved.

### 2.4 Concurrency and idempotency

| Writer | Idempotency key | Server guarantee |
| --- | --- | --- |
| Sale | `clientUuid` = `pos_sales.client_uuid` = `pos_sales.id` | `pos_record_sale` `ON CONFLICT DO NOTHING`; stock guarded by `stock_applied_at` |
| Return | `returnUuid` = `pos_returns.client_uuid` | `pos_record_return` `ON CONFLICT DO NOTHING`; stock only on first insert |
| Product | `product.id` | `upsert(onConflict: "id")` — **currently blocked by RLS** |
| Receipt email | `clientUuid` in payload only | None; duplicate delivery possible |

`state.syncing` only guards **one tab**. Two tabs can run `runSync()` at the
same time. That is safe for sales and returns because the server is idempotent;
it is not safe for receipt emails or for local stock reconciliation while a pull
and a return overlap (see §6.4).

---

## 3. Database schema

### 3.1 Dexie — `lib/db.ts`

Database name: **`pedigree-pos`**. One connection per tab, created lazily by
`getDb()`. The lazy creation is required because this module is evaluated during
server rendering of client components, where `indexedDB` does not exist.

#### Version 1

```ts
products:     "id, name, slug, barcode, category, active, updatedAt"
pos_sales:    "clientUuid, createdAt, syncedAt, paymentMethod"
pos_users:    "id, role, active"
sync_queue:   "++id, entity, entityId, status, createdAt"
```

#### Version 2

```ts
till_sessions: "++id, openedAt, closedAt"
```

Dexie carries v1 tables forward untouched when only a new store is named. An
existing till upgrades in place with no `.upgrade()` step and no lost sales.

#### Table contracts

| Table | Primary key | Fields | Notes |
| --- | --- | --- | --- |
| `products` | `id` (Supabase uuid) | `name, slug, category, barcode, basePrice, discountPercent, stockQuantity, active, imageUrl, updatedAt, colors, isWebsitePublished` | `stockQuantity` is the till’s own count, already reduced by every sale and increased by every return, synced or not. |
| `pos_sales` | `clientUuid` | `cashierId, cashierName, subtotalKes, discountKes, discountPercent, totalKes, paymentMethod, amountTendered, changeDue, paymentReference, createdAt, syncedAt, items[]` | Lines are embedded. `syncedAt` is null until the RPC acknowledges. |
| `pos_users` | `id` | `name, pinHash, role, active, updatedAt` | Includes bcrypt hash so PIN checks work offline. Deliberate, documented tradeoff. |
| `sync_queue` | `++id` (auto) | `entity, entityId, status, attempts, lastError, payload, createdAt, updatedAt` | Outbox. Success deletes the row. |
| `till_sessions` | `++id` (auto) | `openedAt, openedBy, openingFloat, closedAt, closedBy, expectedCash, countedCash, variance` | Local only. No sync queue entry. |

Sale lines are embedded because nothing queries a line independently on the
device, and embedding makes the sale and its lines one atomic write. On the
server they are normalised into `pos_sale_items` because reporting queries them.

#### Adding schema version 3

If a new table is needed (for example a local returns ledger):

```ts
this.version(3).stores({
  local_returns: "clientUuid, createdAt, syncedAt, originalSaleUuid",
});
```

- Name **only the new store** if existing stores are unchanged.
- If adding an index to an existing store, repeat that store’s full index string
  in the new version; Dexie deletes indexes not named.
- Never change a primary key in place. Create a new table and migrate.
- Test the upgrade with a database already populated by v2, not an empty one.

### 3.2 Supabase — tables and migrations

Migrations `001–011` are storefront-owned mirrors. Do not edit them here.
`012–018` are owned by the POS.

| Migration | Purpose | POS-owned |
| --- | --- | --- |
| `001_initial.sql` | `products`, `product_colors`, `product_images`, RLS, public read active products, authenticated full write | no |
| `002_storage.sql` | `product-images` bucket; public read; authenticated upload/update/delete | no |
| `003_orders.sql` | Storefront orders and order items | no |
| `004_stock_rpc.sql` | Storefront atomic stock decrement RPC | no |
| `006_order_status.sql` | Order status flow and history | no |
| `007_admin_users.sql` | Admin users and roles | no |
| `008_shop_settings.sql` | Shop configuration | no |
| `009_delivery_zones.sql` | Delivery zones and fees | no |
| `010_usd_pricing.sql` | `products.base_price_usd` | no |
| `011_shop_settings_socials.sql` | Instagram handle/URL | no |
| `012_pos.sql` | `pos_users`, `pos_sales`, `pos_sale_items`, RLS, `pos_daily_totals` | **yes** |
| `013_pos_stock.sql` | `pos_sales.stock_applied_at`; idempotent `pos_apply_sale_stock` | **yes** |
| `014_pos_record_sale.sql` | `pos_record_sale` — the only sale write path; drops direct insert policies | **yes** |
| `015_pos_card_payments.sql` | Allows `card`; `mpesa_code` doubles as card reference | **yes** |
| `016_pos_staff_enrolment.sql` | Anon may insert active `cashier` rows only | **yes** |
| `017_pos_returns.sql` | `products.is_website_published`, `pos_returns`, `pos_return_items`, `pos_record_return` | **yes** |
| `018_pos_rotate_demo_manager_pin.sql` | Rotates the seeded demo manager PIN away from `9999` | **yes** |
| `019_pos_product_creation.sql` | `pos_create_product`; FK-safe returns; drops direct return writes | **yes** |

> The repository has no `005` migration. That is historical; do not renumber.

#### POS tables in detail

**`pos_users`**

- `id uuid` PK, `name text`, `pin_hash text` (bcrypt), `role text`
  (`cashier|manager`), `active boolean`, `created_at`.
- RLS: `SELECT` to `anon, authenticated` with `USING (true)`; `INSERT` only for
  `role='cashier' AND active=true` (016). No update/delete policy.

**`pos_sales`**

- `id uuid` PK, `client_uuid uuid UNIQUE`, `cashier_id uuid` (nullable),
  `cashier_name`, money columns as integers, `payment_method`
  (`cash|mpesa|card`), `amount_tendered`, `change_due`, `mpesa_code`,
  `created_at`, `synced_at`, `stock_applied_at`.
- RLS: no direct `SELECT`/`INSERT` for `anon` after 014. Writes go through
  `pos_record_sale` only.

**`pos_sale_items`**

- `id uuid` PK, `sale_id`, `product_id` (nullable), `product_name`,
  `quantity > 0`, `price_at_sale >= 0`, `UNIQUE (sale_id, product_id)`.
- RLS: no direct access after 014.

**`pos_returns`**

- `id uuid` PK default `gen_random_uuid()`, `client_uuid uuid UNIQUE`,
  `original_sale_id uuid` → `pos_sales(id)` on delete set null,
  `cashier_id`, `cashier_name`, `manager_id`, `manager_name`, `created_at`,
  `synced_at`.
- No refund amount, refund method, or restock flag.

**`pos_return_items`**

- `id uuid` PK, `return_id`, `product_id` (nullable), `product_name`,
  `quantity > 0`. No `UNIQUE (return_id, product_id)`.

**`pos_record_sale`** — SECURITY DEFINER. One sale + lines + stock decrement in
one transaction. `RETURNS boolean` (`true` recorded, `false` replay).

**`pos_apply_sale_stock`** — SECURITY DEFINER, guarded by
`pos_sales.stock_applied_at`, `GREATEST(0, stock - qty)`. No grant to `anon`
after 014; called only by `pos_record_sale`.

**`pos_record_return`** — SECURITY DEFINER. Inserts the return, its lines, and
increments stock. `ON CONFLICT (client_uuid) DO NOTHING`; returns `false` on a
replay and does not touch stock.

#### Current anon capability surface

| Capability | Object | Notes |
| --- | --- | --- |
| SELECT | `products` | Only `active = true` (storefront policy) |
| SELECT | `product_colors`, `product_images` | Only rows under an active product |
| SELECT | `pos_users` | All rows, including hashes (012 tradeoff) |
| INSERT | `pos_users` | Only `cashier` + `active` (016) |
| CALL | `pos_record_sale` | The only sale write path |
| CALL | `pos_record_return` | The only intended return write path |
| CALL | `pos_daily_totals` | Aggregates only; unused by the UI |
| **INSERT** | **`pos_returns`, `pos_return_items`** | **Still allowed by 017 policies; should be dropped** |
| INSERT/UPDATE | `products` | **Not allowed** — blocks Feature C |
| Upload | `storage.objects` (`product-images`) | Authenticated only — blocks POS image upload |

### 3.3 `sync_queue` entities

| Entity | `entityId` | Payload | Producer | Consumer | Server idempotency |
| --- | --- | --- | --- | --- | --- |
| `sale` | sale `clientUuid` | `null` | `completeSale()` | `syncSales()` / `pos_record_sale` | `client_uuid` |
| `receipt_email` | sale `clientUuid` | `{ email }` | `queueReceiptEmail()` | `syncReceiptEmails()` / API route | none |
| `return` | return UUID | `{ original_sale_id, cashier_id, cashier_name, manager_id, manager_name, items[] }` | `recordReturn()` | `syncReturns()` / `pos_record_return` | `client_uuid` |
| `product` | product `id` | `{ name, slug, category, basePrice, colors, isWebsitePublished, imageUrl }` | `product-form.tsx` | `syncProducts()` / `pushProduct` | product `id` |

Status values are only `"pending"` and `"error"`. There is no `"processing"` or
`"dead"` state. A successful push deletes the row. A failed push sets
`"error"` and is retried on every subsequent run.

### 3.4 Stock has three representations

| Representation | Where | What it means |
| --- | --- | --- |
| Local stock | `products.stockQuantity` in Dexie | What the till believes is on the shelf right now, including unsynced sales/returns |
| Server stock | `products.stock_quantity` in Postgres | What the shared storefront and other devices see, including only synced changes |
| Pending delta | `pendingStockByProduct()` | Units sold but not synced, minus units returned but not synced |

The invariant is:

```text
local stock after a pull = max(0, server stock − pending net decrement)
```

Any feature that changes stock must preserve this equation or explicitly extend
`pendingStockByProduct()`.

---

## 4. Security and authentication

### 4.1 PIN sign-in flow

1. `/login` renders `PinLogin`.
2. On mount, `PinLogin` calls `fetchPosUsers()` to pull the active roster into
   Dexie. A network failure is logged and ignored.
3. It reads active users from `pos_users`.
4. The cashier types a 4-digit PIN on the keypad. The hidden
   `<input type="password">` is the real control; the dots are visual.
5. On the fourth digit, `submit()` reads every active user and calls
   `verifyPin(candidate, user.pinHash)` until one matches. **First match wins;
   there is no user picker.**
6. On success, `createSession({ id, name, role })` is written to
   `localStorage` under `pedigree-pos.session`; then
   `window.location.replace("/pos")` performs a hard navigation.
7. On failure, the PIN clears, the attempt count rises, and five failures lock
   the keypad for 30 seconds. The lockout is client-side only.
8. A signed-in user visiting `/login` is redirected to `/pos`.

`verifyPin` uses `bcrypt.compare` (cost 10). The PIN is never stored, only the
bcrypt hash. The roster is cached so this works with no network.

### 4.2 Session and route guards

`PosSession`:

```ts
{ id: string; name: string; role: "cashier" | "manager"; loggedInAt: string }
```

- Stored in `localStorage`, not a cookie.
- Read through `useSyncExternalStore` in `components/auth-provider.tsx`.
- `status` is `"loading"` until the first client read, then `"ready"`.
- `RequireAuth` is a **client component**, not middleware. Middleware runs on the
  server, which is exactly what is unavailable offline.
- `RequireAuth` waits for `status === "ready"` before redirecting. Without that,
  a signed-in cashier would be bounced on every reload.
- Redirects use `window.location.replace`, not `router.push`, because a document
  request for a precached route is served by the service worker.
- `role="manager"` sends a signed-in cashier to `/pos`.
- The entire `/manager` subtree is protected once, in
  `app/manager/layout.tsx`.

### 4.3 The honest security boundary

This is a **convenience boundary, not a security boundary**. The session is
editable in DevTools. The manager check is client-side. The PIN hashes are
readable with the anon key. A 4-digit PIN has 10,000 possibilities.

Real enforcement would require a server session or per-device tokens, network
PIN verification, and short-lived offline assertions. Until then:

- RLS is the only real server boundary.
- Never put the service-role key in the browser.
- Treat `pos_users.pin_hash` as compromised if the anon key leaks.
- Do not add new privileged operations as direct anon table policies. Use a
  narrow `SECURITY DEFINER` RPC, as `014` did for sales.

### 4.4 The `9999` manager bypass — removed in Phase 0

Both bypasses are gone. The login path is roster-backed again and the only way
to authenticate is `bcrypt.compare` against a hash cached from `pos_users`.

**What changed**

1. **`components/auth/pin-login.tsx`** — the `candidate === "9999"` branch is
   deleted. Sign-in now reads active users from IndexedDB and matches the PIN
   against each user’s hash. No roster or per-user data is logged.
2. **`lib/auth.ts`** — `verifyPin` is only:

   ```ts
   export async function verifyPin(pin: string, hash: string): Promise<boolean> {
     try {
       return await bcrypt.compare(normalizePin(pin), hash);
     } catch {
       return false;
     }
   }
   ```

   The generated `9999` hash and all PIN/hash logging are gone.
3. **`components/supabase-connection-check.tsx`** — deleted, and its mount
   removed from `app/login/page.tsx`.
4. **Seed and data** — `supabase/pos_seed.sql` now gives Grace Wanjiru the demo
   PIN `4826`, and `018_pos_rotate_demo_manager_pin.sql` updates the seeded
   Grace row in an existing database. `9999` is deliberately not a valid PIN.

**Why the demo PIN moved**

The seed hash was already a valid bcrypt hash for `9999`, so deleting the code
bypasses alone would have left `9999` working as a real manager credential.
Rotating the demo manager to `4826` makes the removal test meaningful.

**Acceptance tests**

- `9999` fails.
- `4826` signs in as Grace, online and offline, after `018` has been applied.
- A cashier’s PIN cannot approve a return.
- A sale rung up by a manager syncs successfully (real UUID).
- No PIN, hash, or roster appears in the console.
- The seeded demo hash is rotated before production; `4826` is not a production
  secret.

---

## 5. Feature A — VFD customer display (Web Serial)

### 5.1 Current state

**Not implemented.** There is no serial code, no dependency, and no UI. This is
a greenfield feature and can be built independently of the sync engine.

### 5.2 Goal and constraints

- Show the current item and running total on a 2×20 VFD/LED customer display.
- Use the Web Serial API via
  `@point-of-sale/webserial-customer-display`.
- The connection must be **user-triggered** (“Connect display”) because
  `navigator.serial.requestPort()` requires transient user activation.
- The display must never block, slow, or fail a sale.
- Unsupported browsers and missing hardware must degrade silently to “no
  display”.

Browser support: Chromium-based desktop browsers (Chrome, Edge, Electron) in a
secure context (`https://` or `localhost`). Firefox and Safari do not support
Web Serial. The till is already Chromium-first, so this is acceptable.

Package facts (v1.0.0):

- Default export: `WebSerialCustomerDisplay`.
- Constructor options: `language` (`"auto" | "bixolon" | "digipos"`),
  `baudRate` (default 9600), `dataBits`, `stopBits`, `parity`, `flowControl`,
  `bufferSize`.
- `connect()` must be called from a user gesture. It **catches its own errors
  and logs them**, so a failed connect does not reject; rely on the `connected`
  event or a timeout.
- `reconnect({ vendorId, productId })` finds an already-granted port. It does
  not prompt. Store the ids from the `connected` event.
- `line(string | [string, string])` writes two 20-character lines. A single
  string scrolls the previous bottom line to the top.
- `clear()` clears the screen.
- `disconnect()` releases the writer and closes the port.
- `connected` / `disconnected` events are available via `addEventListener`.
- **No TypeScript declarations ship with the package.** Add an ambient
  declaration file.
- `language: "auto"` only recognises USB vendor ids for Bixolon (`5380`) and
  Digipos (`4292`). A USB-to-serial adapter or an unknown device needs an
  explicit `language`.
- The constructor touches `navigator.serial.addEventListener` immediately.
  Constructing it during SSR or render will throw.

### 5.3 Architecture: keep React out of the serial path

Do **not** put `WebSerialCustomerDisplay` state inside `pos-screen.tsx` and
`checkout-dialog.tsx` separately. Use one tab-level controller and a small hook.
This mirrors the existing `lib/sync.ts` external-store pattern.

```text
components/pos/pos-screen.tsx ─┐
components/pos/checkout-dialog.tsx ─┤   useCustomerDisplay()
components/pos/receipt-dialog.tsx ─┘          │
                                              ▼
                             lib/customer-display.ts (singleton)
                              ├─ one WebSerialCustomerDisplay instance
                              ├─ device state (external store)
                              ├─ latest-frame coalescing
                              └─ serialized write loop
                                              │
                                              ▼
                                      navigator.serial
```

Why this shape:

- Serial writes are asynchronous and can fail when the cable is pulled. They
  must not share a React render lifecycle.
- Both the POS screen and the checkout form need to paint frames. A singleton
  avoids two instances competing for the same port.
- A latest-wins frame buffer prevents a fast cashier from queuing 200 writes
  behind a 9600-baud device.
- Status can be subscribed to without prop-drilling.

### 5.4 Files to create or modify

| File | Action | Purpose |
| --- | --- | --- |
| `package.json` | modify | Add `@point-of-sale/webserial-customer-display` |
| `types/webserial-customer-display.d.ts` | **create** | Ambient module declaration; the package ships no types |
| `lib/customer-display.ts` | **create** | Singleton controller, external store, write queue, reconnect, formatting |
| `hooks/use-customer-display.ts` | **create** | `useSyncExternalStore` + stable command functions |
| `components/pos/customer-display-control.tsx` | **create** | “Connect display” button, status badge, permission/error copy |
| `components/pos/pos-screen.tsx` | modify | Render the control; paint cart/item/total/paid frames |
| `components/pos/checkout-dialog.tsx` | modify | Paint tender/change/method frames |
| `components/pos/receipt-dialog.tsx` | modify (optional) | “Thank you” frame while the receipt is open |
| `app/globals.css` | modify (optional) | Only if a new status token is needed; reuse success/warning/danger |

Install:

```bash
pnpm add @point-of-sale/webserial-customer-display
```

### 5.5 Ambient type declaration

```ts
// types/webserial-customer-display.d.ts
declare module "@point-of-sale/webserial-customer-display" {
  export interface CustomerDisplayOptions {
    language?: "auto" | "bixolon" | "digipos";
    baudRate?: number;
    bufferSize?: number;
    dataBits?: 7 | 8;
    flowControl?: "none" | "hardware";
    parity?: "none" | "even" | "odd";
    stopBits?: 1 | 2;
  }

  export interface CustomerDisplayDevice {
    type: "serial";
    language: string;
    vendorId: number | null;
    productId: number | null;
  }

  export default class WebSerialCustomerDisplay {
    constructor(options?: CustomerDisplayOptions);
    connect(): Promise<void>;
    reconnect(device: { vendorId: number; productId: number }): Promise<void>;
    disconnect(): Promise<void>;
    clear(): Promise<void>;
    line(text: string | [string, string]): Promise<void>;
    addEventListener(
      type: "connected",
      listener: (device: CustomerDisplayDevice) => void,
    ): void;
    addEventListener(type: "disconnected", listener: () => void): void;
  }
}
```

### 5.6 Controller sketch (`lib/customer-display.ts`)

```ts
"use client";

import WebSerialCustomerDisplay, {
  type CustomerDisplayDevice,
} from "@point-of-sale/webserial-customer-display";

export type DisplayStatus =
  | "unsupported"
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface CustomerDisplayState {
  supported: boolean;
  status: DisplayStatus;
  device: { vendorId: number; productId: number } | null;
  error: string | null;
}

const DEVICE_KEY = "pedigree-pos.customer-display.device";
const CONNECT_TIMEOUT_MS = 8_000;

let state: CustomerDisplayState = {
  supported: false,
  status: "disconnected",
  device: null,
  error: null,
};
const listeners = new Set<() => void>();

let display: WebSerialCustomerDisplay | null = null;
let writeInFlight = false;
let latestFrame: [string, string] | null = null;
let connectTimer: number | null = null;
/** Both PosScreen and CheckoutDialog mount the hook; only one may claim a port. */
let reconnectAttempted = false;

function emit(patch: Partial<CustomerDisplayState>): void {
  let changed = false;
  for (const key of Object.keys(patch) as (keyof CustomerDisplayState)[]) {
    if (!Object.is(state[key], patch[key])) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): CustomerDisplayState {
  return state;
}

export function isSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

function ensureDisplay(): WebSerialCustomerDisplay | null {
  if (!isSupported()) {
    emit({ supported: false, status: "unsupported" });
    return null;
  }
  emit({ supported: true });

  if (display !== null) return display;

  // The constructor touches navigator.serial, so this must only run client-side.
  display = new WebSerialCustomerDisplay({
    language: "auto", // override to "bixolon" / "digipos" for non-USB adapters
    baudRate: 9600,
  });

  display.addEventListener("connected", (device) => {
    clearConnectTimer();
    const ids =
      device.vendorId !== null && device.productId !== null
        ? { vendorId: device.vendorId, productId: device.productId }
        : null;
    if (ids !== null) {
      localStorage.setItem(DEVICE_KEY, JSON.stringify(ids));
    }
    emit({ status: "connected", device: ids, error: null });
    // A frame painted while disconnected is still waiting; show it now.
    void flush();
  });

  display.addEventListener("disconnected", () => {
    clearConnectTimer();
    emit({ status: "disconnected" });
  });

  return display;
}

function clearConnectTimer(): void {
  if (connectTimer === null) return;
  window.clearTimeout(connectTimer);
  connectTimer = null;
}

export async function connect(): Promise<void> {
  const device = ensureDisplay();
  if (device === null) return;

  clearConnectTimer();
  emit({ status: "connecting", error: null });

  // connect() swallows its own errors, so a timeout is the only reliable
  // signal that the user cancelled the picker or the port did not open. Do
  // not clear it when connect() resolves: cancellation also resolves.
  connectTimer = window.setTimeout(() => {
    connectTimer = null;
    if (state.status === "connecting") {
      emit({ status: "error", error: "No display responded. Check the cable and port." });
    }
  }, CONNECT_TIMEOUT_MS);

  try {
    await device.connect();
  } catch (error) {
    clearConnectTimer();
    emit({
      status: "error",
      error: error instanceof Error ? error.message : "Could not connect.",
    });
  }
}

export async function tryReconnect(): Promise<void> {
  // Two mounted hooks must not race to open the same port.
  if (reconnectAttempted) return;
  reconnectAttempted = true;

  if (!isSupported()) return;
  const device = ensureDisplay();
  if (device === null) return;

  const raw = localStorage.getItem(DEVICE_KEY);
  if (raw === null) return;

  try {
    const ids = JSON.parse(raw) as { vendorId?: unknown; productId?: unknown };
    if (typeof ids.vendorId !== "number" || typeof ids.productId !== "number") {
      return;
    }
    await device.reconnect({ vendorId: ids.vendorId, productId: ids.productId });
  } catch {
    // No previously granted port, or it is gone. Stay disconnected silently.
  }
}

export async function disconnect(): Promise<void> {
  clearConnectTimer();
  if (display === null) return;
  try {
    await display.disconnect();
  } catch {
    /* already closed */
  }
  emit({ status: "disconnected" });
}

export function fitLine(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 20).padEnd(20, " ");
}

/** Latest-wins. Never awaited by a cashier action. */
export function paint(top: string, bottom: string): void {
  latestFrame = [fitLine(top), fitLine(bottom)];
  if (writeInFlight) return;
  void flush();
}

async function flush(): Promise<void> {
  const device = display;
  if (device === null || state.status !== "connected") return;

  writeInFlight = true;
  try {
    while (latestFrame !== null) {
      const frame = latestFrame;
      latestFrame = null;
      await device.line(frame);
    }
  } catch (error) {
    emit({
      status: "error",
      error: error instanceof Error ? error.message : "Display write failed.",
    });
  } finally {
    writeInFlight = false;
    // A frame painted between the last null check and this line must not strand.
    if (latestFrame !== null) void flush();
  }
}
```

`paint` is synchronous from the caller’s perspective. Serial I/O happens on a
detached promise. If the cable is pulled, `flush` catches, sets a status, and the
next paint after reconnect resumes.

### 5.7 Hook sketch (`hooks/use-customer-display.ts`)

```ts
"use client";

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
  connect,
  disconnect,
  getState,
  paint,
  subscribe,
  tryReconnect,
} from "@/lib/customer-display";
import { formatAmount } from "@/lib/format";

export function useCustomerDisplay() {
  const state = useSyncExternalStore(subscribe, getState, getState);

  useEffect(() => {
    // Reconnect only to a port the browser already granted. No prompt on load.
    void tryReconnect();
  }, []);

  const showIdle = useCallback(() => {
    paint("WELCOME", "PEDIGREE LEATHER");
  }, []);

  const showItem = useCallback((name: string, totalKes: number) => {
    paint(name.toUpperCase(), `TOTAL KES ${formatAmount(totalKes)}`);
  }, []);

  const showTotal = useCallback((totalKes: number, count: number) => {
    paint(`${count} ITEM${count === 1 ? "" : "S"}`, `TOTAL KES ${formatAmount(totalKes)}`);
  }, []);

  const showCash = useCallback(
    (tendered: number, totalKes: number, change: number, short: boolean) => {
      paint(
        `TENDERED ${formatAmount(tendered)}`,
        short
          ? `SHORT ${formatAmount(totalKes - tendered)}`
          : `CHANGE ${formatAmount(change)}`,
      );
    },
    [],
  );

  const showMethod = useCallback((method: string, totalKes: number) => {
    paint(method.toUpperCase(), `TOTAL KES ${formatAmount(totalKes)}`);
  }, []);

  const showPaid = useCallback((totalKes: number, change: number | null) => {
    paint(
      "PAYMENT COMPLETE",
      change !== null && change > 0
        ? `CHANGE ${formatAmount(change)}`
        : `KES ${formatAmount(totalKes)}`,
    );
  }, []);

  return useMemo(
    () => ({
      ...state,
      connect,
      disconnect,
      showIdle,
      showItem,
      showTotal,
      showCash,
      showMethod,
      showPaid,
    }),
    [
      state,
      showIdle,
      showItem,
      showTotal,
      showCash,
      showMethod,
      showPaid,
    ],
  );
}
```

Return values are stable (`useCallback` with no dependencies), so effects that
depend on them do not re-run on every render. The returned object is memoized
too, so `display` itself is a safe effect dependency; without that, `{ ...state,
… }` would be a new object each render and every effect keyed on `display` would
re-run.

`supported` starts `false` so the server render and the hydrating client render
agree; the mount effect flips it through `ensureDisplay()`. Do not compute
`supported` from `navigator.serial` during render — that is a hydration mismatch
and the reason the first paint must not probe device APIs.

### 5.8 Where to update the display

#### `components/pos/pos-screen.tsx`

1. **Mount / connection**
   - Render `<CustomerDisplayControl />` next to the “Return / Refund” button
     (or in the header area). It owns the user-triggered “Connect display”
     button.
   - Call `const display = useCustomerDisplay()` once.
   - On mount, call `display.showIdle()`.

2. **Item added**
   - In `addToCart`, record the name of the last added product in a ref:

     ```ts
     const lastAddedRef = useRef<string | null>(null);

     const addToCart = useCallback((product: LocalProduct) => {
       lastAddedRef.current = product.name;
       dispatch({ type: "add", product: { ... } });
     }, [dispatch]);
     ```

   - Use an effect on the cart and totals so increments, decrements, removals,
     and discounts all repaint:

     ```ts
     useEffect(() => {
       if (cart.lines.length === 0) {
         display.showIdle();
         return;
       }
       display.showItem(
         lastAddedRef.current ?? cart.lines[cart.lines.length - 1]?.name ?? "",
         totals.totalKes,
       );
     }, [cart, totals.totalKes, display]);
     ```

   - `paint` is latest-wins, so scanning three items quickly does not queue
     three slow serial writes; the display lands on the final state.

3. **Payment complete**
   - In `handleConfirm`, inside the async IIFE, **after** `completeSale`
     resolves (the sale is already durable at that point):

     ```ts
     const sale = await completeSale({ ... });
     display.showPaid(sale.totalKes, sale.changeDue);
     dispatch({ type: "clear" });
     setCheckoutOpen(false);
     setCompletedSale(sale);
     ```

   - Never call the display before `completeSale` or inside its Dexie
     transaction. The display is a notification, not part of the sale.
   - When the receipt dialog closes, show the idle frame again.

4. **Return complete**
   - After `handleReturnComplete`, show the new total or idle frame. A return
     does not change the current cart, so idle is appropriate.

5. **Charge pressed**
   - In `onCharge`, call `display.showTotal(totals.totalKes, itemCount)` before
     opening the dialog, so the customer sees the amount while the cashier
     enters payment.

#### `components/pos/checkout-dialog.tsx`

`CheckoutForm` owns the live tender state, so it should paint the payment
frames. It can call `useCustomerDisplay()` directly; the singleton controller
means it shares the same device as `PosScreen`.

1. **Dialog opens / method changes**

   ```ts
   useEffect(() => {
     display.showMethod(method, totals.totalKes);
   }, [method, totals.totalKes, display]);
   ```

2. **Cash tendered changes**

   ```ts
   useEffect(() => {
     if (method !== "cash") return;
     if (tenderedValue <= 0) {
       display.showTotal(totals.totalKes, itemCount);
       return;
     }
     display.showCash(tenderedValue, totals.totalKes, change, short);
   }, [
     method, tenderedValue, totals.totalKes, change, short, itemCount, display,
   ]);
   ```

   This effect runs on every keystroke. That is safe because `paint` coalesces:
   only the latest frame is written, and only one write is in flight.

3. **M-Pesa / card**
   - Show `MPESA` or `CARD` plus the total. Do **not** show the confirmation
     code or card reference on the customer display; those are payment
     credentials and belong on the receipt, not the counter-facing screen.

4. **On submit**
   - Do not paint “PAID” here. The form only calls `onConfirm`; the actual sale
     is committed in `PosScreen.handleConfirm`. Painting “PAID” before
     `completeSale` resolves would lie if the local write failed.

5. **On cancel / close**
   - Restore the cart total: `display.showTotal(totals.totalKes, itemCount)`.

#### `components/pos/receipt-dialog.tsx`

Optional: while the receipt is open, paint `THANK YOU` / `KARIBU TENA`. On close,
paint the idle/first item frame. This is cosmetic and must not block printing.

### 5.9 Connection UX

`components/pos/customer-display-control.tsx`:

- If `!supported`: render nothing, or a subtle “Display not supported in this
  browser” note in a manager-only area. Do not take space from the till.
- If `disconnected`: a “Connect display” button. Clicking calls `connect()`.
- If `connecting`: a disabled button with a spinner.
- If `connected`: a green “Display connected” pill with a “Disconnect” action.
- If `error`: an amber/red pill whose `title` carries the error, plus a
  “Retry” button. Never a modal, never a blocking alert.
- Persist only `{ vendorId, productId }` in `localStorage`; the browser owns the
  permission grant.
- On mount, `tryReconnect()` is best-effort. It must not prompt. If the user
  revoked permission, stay disconnected.

### 5.10 Failure modes and required behaviour

| Failure | Required behaviour |
| --- | --- |
| Browser has no Web Serial | Hide the control; sales unaffected |
| User cancels the port picker | `connect()` resolves (library swallows); timeout sets `error`; sales unaffected |
| Port open fails | Library swallows the error; the 8s timeout sets `error`; retry available |
| Unknown USB vendor with `language: "auto"` | `open()` throws inside the library and is swallowed; timeout sets `error`; set an explicit `language` or document the device |
| Cable pulled mid-write | `flush` catches; status `disconnected`/`error`; next paint after reconnect works |
| Cashier scans rapidly | Latest-wins; at most one frame in flight; no backlog |
| Device is slow (9600 baud) | `paint` returns immediately; UI never waits |
| Text longer than 20 chars | Truncate/pad in `fitLine`; do not let the library silently cut mid-frame |
| Non-ASCII / emoji | The library encodes legacy code pages; unsupported glyphs become `?`. Keep display text ASCII where possible |
| React Strict Mode double-mount | Singleton display + idempotent listeners; do not disconnect on every unmount |
| Server render | Never construct the controller; `useEffect`/client-only guard |

### 5.11 Testing Feature A

1. `pnpm dev`, open `/pos` in Chrome.
2. Without a device: the control should show “Connect display” only if
   `navigator.serial` exists; clicking opens the browser picker.
3. Connect a real VFD or a USB-serial loopback. Confirm the `connected` event
   stores the vendor/product ids.
4. Add an item: first line is the item name, second is the total.
5. Increment quantity / toggle the 10% discount: total updates, no lag on the
   UI.
6. Open checkout, type a tender: display shows tendered and change.
7. Complete a cash sale: display shows “PAYMENT COMPLETE” and the change.
8. Unplug the cable mid-sale: the sale still completes; the display control
   shows an error; reconnect works.
9. Reload: `tryReconnect()` reconnects without a prompt (if permission is
   retained).
10. Run with `prefers-reduced-motion` and a screen reader: the display changes
    must not be announced as app UI changes; it is a separate device.

---

## 6. Feature B — manager-approved returns (partial)

### 6.1 What exists today

```text
pos-screen.tsx
  └─ “Return / Refund” button ──► ReturnPinDialog
                                     │ verifyPin against local managers
                                     ▼
                                  ReturnDialog
                                     │ select recent sale or scan barcode
                                     │ choose item + quantity
                                     ▼
                                  lib/returns.ts recordReturn()
                                     │ one Dexie transaction:
                                     │   products.stockQuantity += qty
                                     │   sync_queue.add({ entity:"return", … })
                                     ▼
                                  lib/sync.ts syncReturns()
                                     │ pushReturn(entry)
                                     ▼
                                  Supabase pos_record_return()
                                     │ insert pos_returns + pos_return_items
                                     │ products.stock_quantity += qty
                                     ▼
                                  success → delete queue row
```

Implemented:

- Manager PIN gate (`return-pin-dialog.tsx`).
- Recent-sale selection and barcode scan (`return-dialog.tsx`).
- Local stock increment and queue entry (`lib/returns.ts`).
- Sync push and server RPC (`lib/sync.ts`, `017_pos_returns.sql`).
- `pendingStockByProduct()` offsets pending returns during a catalogue pull.

Not implemented / incomplete:

- The chosen return quantity is **ignored** (see below).
- Returns are not recorded in a local ledger; once the queue row is deleted,
  the till has no local return history.
- No record of how many units of a sale line were already returned.
- No refund amount or refund method is stored.
- The return dialog does not reset after completion and does not refresh its
  sale list.
- `pendingStockByProduct()` ignores returns whose queue status is `"error"`.
- The catalogue pull computes pending stock outside the write transaction, so a
  concurrent return can be overwritten.
- The manager PIN check is client-side only; the RPC is callable by anon.
- `pos_returns` / `pos_return_items` still allow direct anon inserts (017), which
  bypasses the RPC and its stock update.

### 6.2 `lib/returns.ts` in detail

`recordReturn(input)`:

1. Generates `returnUuid = crypto.randomUUID()` and `now = nowIso()`.
2. Opens a Dexie read/write transaction over `products` and `sync_queue`.
3. For each returned item:
   - Read the local product.
   - If it is missing (delisted), **skip it** rather than failing the return.
   - `stockQuantity = product.stockQuantity + item.quantity`.
4. Call `addSyncQueueEntry()` with:
   ```ts
   {
     entity: "return",
     entityId: returnUuid,
     payload: {
       original_sale_id: originalSale?.clientUuid ?? null,
       cashier_id, cashier_name,
       manager_id, manager_name,
       items: [{ product_id, product_name, quantity }],
     },
     createdAt: now,
     updatedAt: now,
   }
   ```
5. Return the UUID.

The transaction is the durability guarantee: the stock increment and the queue
row either both commit or neither does. The cart is not involved. The network is
not awaited.

`applyReturnLocally(items)` exists but is **unused**. It does a non-atomic
read-then-update per item and has no idempotency marker. Either delete it or
replace it with a ledger-based replay function; do not build on it.

### 6.3 `lib/sync.ts` push path

`syncReturns()` selects all queue rows with `entity = "return"` and calls
`pushReturn()`:

- `p_client_uuid` ← `entry.entityId`
- `p_original_sale_id` ← payload
- `p_cashier_id` / `p_cashier_name`
- `p_manager_id` / `p_manager_name`
- `p_items` ← payload items

`pos_record_return`:

1. Inserts `pos_returns` `ON CONFLICT (client_uuid) DO NOTHING RETURNING id`.
2. If no id was returned, the return already exists: return `false`, no stock
   change.
3. Insert each `pos_return_items` row.
4. `UPDATE products p SET stock_quantity = p.stock_quantity + i.quantity FROM
   (jsonb elements) i WHERE p.id = i.product_id`.
5. Return `true`.

**Foreign keys are strict, and the function does not guard them.** Three
references can make a return fail even though the local transaction succeeded:

- `original_sale_id` → `pos_sales(id)`. The client sends the sale’s
  `clientUuid`, which is the server’s `id` only after 014. If that sale has not
  synced (or its push failed), the insert raises `23503` and the return cannot
  be recorded.
- each `pos_return_items.product_id` → `products(id)`. A product that was
  hard-deleted server-side, or created locally and never pushed (Feature C),
  does not exist in `products`; the item insert fails before the stock `UPDATE`
  runs. “The join silently skips it” is only true for the `UPDATE`, not for the
  insert.
- `cashier_id` / `manager_id` → `pos_users(id)`. A non-UUID placeholder fails
  at argument binding; an unknown UUID fails at insert.

The fix is twofold: resolve optional ids to `NULL` on the client when they are
not valid UUIDs (see §6.6), and resolve sale/product references against the
server inside the RPC instead of trusting them.

On success the client deletes the queue row. There is no local `syncedAt`
because there is no local return entity. This is the core design gap: the queue
row is both the work item and the only local record.

### 6.4 How `pendingStockByProduct()` handles returns

It is called by `fetchProducts()` before writing the catalogue. It builds a
`Map<productId, pendingDelta>`:

1. Read every `pos_sales` row with `syncedAt === null`.
2. For each line with a `productId`, **add** its quantity. These are units the
   server still thinks are on the shelf.
3. Read every `sync_queue` row with `entity = "return"` and
   `status = "pending"`.
4. For each returned item with a `product_id`, **subtract** its quantity,
   **clamped at 0** by the current code (see the defect below).
5. Return the map.

Then `fetchProducts()` writes:

```ts
stockQuantity: Math.max(0, row.stock_quantity - (pending.get(row.id) ?? 0))
```

Worked example:

| Event | Server stock | Local stock | Pending map | Pulled local stock |
| --- | --- | --- | --- | --- |
| Baseline | 10 | 10 | `{}` | 10 |
| Sale 2 (unsynced) | 10 | 8 | `{ p: 2 }` | 8 |
| Return 1 (pending) | 10 | 9 | `{ p: 1 }` | 9 |
| Sale syncs | 8 | 9 | `{ p: 0 }` — **clamped** | **8** (wrong; should be 9) |
| Return syncs | 9 | 9 | `{}` | 9 |

The net formula is `server − (unsynced sales − unsynced returns)`. Because the
return delta is negative, subtracting it **adds** the returned units back to the
pulled figure, matching the local increment. But the implementation clamps each
return subtraction at 0, which throws the signed delta away. Once the sale has
synced, there is no positive sale delta left to absorb the return, so the map
becomes `0` instead of `-1` and the pull writes the server’s pre-return figure.
The correct implementation keeps the delta signed and clamps only the final
stock written to the catalogue:

```ts
byProduct.set(
  item.product_id,
  (byProduct.get(item.product_id) ?? 0) - item.quantity,
);
// …
stockQuantity: Math.max(0, row.stock_quantity - (pending.get(row.id) ?? 0)),
```

This is not an edge case: “sale synced, then a return is rung up, then the
catalogue is refreshed before the return syncs” is the ordinary path. The
current clamp silently drops the returned unit until the return push succeeds.

What it handles correctly:

- A pending return made while offline, **with an equal or larger pending sale
  on the same product**, followed by a catalogue pull after a reconnect that has
  not yet pushed the return.
- A sale and a return for the same product, both pending, netting correctly
  **as long as the net delta is non-negative**. A pending return that exceeds
  the unsynced sale quantity is clamped and lost (see below).
- A return for a product that was merely **deactivated** (`active = false`):
  the product row still exists, so the FK and the stock `UPDATE` both apply.
  Whether an inactive product should receive stock is a business decision this
  function does not encode.
- Sales whose `syncedAt` is null regardless of queue status.

What it does **not** handle:

- The `Math.max(0, …)` clamp on the return delta. Any pending return that has no
  matching unsynced sale is erased by the next pull — the normal “sale synced,
  return rung up, refresh before sync” path. This is the most likely way the
  till silently loses returned stock.
- Returns in `status = "error"`. They are excluded by the `.filter(entry =>
  entry.status === "pending")`, even though `syncReturns()` retries them. A
  catalogue pull after a failed return will reset local stock to the server’s
  lower figure, losing the returned unit.
- A return that commits **after** the pending map is computed but **before**
  `bulkPut`. The map is read outside the write transaction, so the pull can
  overwrite the just-incremented stock.
- A return whose RPC succeeded but whose queue row was not deleted (crash after
  server commit). The pending map subtracts it again, undercounting after a
  manual “Refresh catalogue” until the next full sync repairs it.
- A return with two lines for the same product. The server’s `UPDATE … FROM`
  with duplicate `product_id` rows applies an arbitrary one, while the local
  loop adds both. Local and server diverge. The current UI returns one line at
  a time, so this is latent, but the RPC and table should enforce or aggregate
  duplicates.
- A return for a product that is **missing** from `products` (hard-deleted, or
  created locally but never pushed). The `pos_return_items` insert violates
  `product_id → products(id)` and the whole return fails; the `UPDATE` join
  never runs. A delisted-but-present (`active = false`) product is fine.
- A return whose original sale has not reached the server. `original_sale_id`
  points at `pos_sales(id)`; the insert fails with `23503` until the sale
  syncs. `runSync` pushes sales first, so this only surfaces when a sale push
  is failing. Then null the reference if the sale is unknown.
- Repeat returns of the same sale line. Nothing tracks already-returned units,
  so a manager can return the same unit repeatedly, inflating stock both
  locally and on the server.

### 6.5 Known defects in the current return flow

| # | Defect | Where | Effect |
| --- | --- | --- | --- |
| B1 | `handleConfirm` passes `selectedItem.quantity`, not the edited `returnQuantity` | `return-dialog.tsx` | Partial returns are impossible; the whole line quantity is always returned |
| B2 | `ConfirmReturn`’s quantity input updates parent state but `onConfirm()` takes no argument | `return-dialog.tsx` | The user’s chosen quantity is silently ignored |
| B3 | Dialog `mode` is never reset on close/open; sales list loads once with `[]` deps | `return-dialog.tsx` | The next return opens on “Return recorded”; the sale list goes stale |
| B4 | `pendingStockByProduct` filters return status to `"pending"` | `lib/sync.ts` | Error-status returns are lost on the next catalogue pull |
| B5 | Pending snapshot is computed before the catalogue write transaction | `lib/sync.ts` | A concurrent return/sale between snapshot and `bulkPut` is overwritten |
| B6 | No local returns ledger; queue row deleted on success | `lib/returns.ts` | No local audit/history; cannot prevent repeat returns |
| B7 | Direct anon INSERT policies on `pos_returns` / `pos_return_items` remain | `017_pos_returns.sql` | A caller can record a return without the RPC, so stock is not incremented |
| B8 | `p_manager_id` can be `""` if a caller passes a blank manager | `return-dialog.tsx` / `pushReturn` | `uuid` cast fails; return stays in error |
| B9 | No refund amount/method | schema | The till records stock, not money returned |
| B10 | `pos_record_return` `UPDATE … FROM` duplicate product rows | `017_pos_returns.sql` | Batch returns for one product can under-apply stock |
| B11 | Manager approval is client-side only | `return-pin-dialog.tsx` | Anon can call the RPC directly; PIN gate is not a server boundary |
| B12 | Pending return delta is clamped at 0 | `lib/sync.ts` (`pendingStockByProduct`); reachable from the dashboard’s “Refresh catalogue” button | A pending return with no unsynced sale is erased by the next catalogue pull |
| B13 | `pos_record_return` trusts `original_sale_id` and `product_id` foreign keys | `017_pos_returns.sql` | A return for an unsynced sale or an unpushed/deleted product fails with `23503` and never applies stock |

### 6.6 Recommended fix plan for Feature B

**P0 — correctness, before any new return feature ships**

1. **Pass the chosen quantity end to end.**

   ```ts
   // return-dialog.tsx
   function handleConfirm(quantity: number) { … recordReturn({
     items: [{ productId: selectedItem.productId,
               productName: selectedItem.productName,
               quantity }],
   }) }

   // ConfirmReturn
   <button onClick={() => onConfirm(quantity)} …>
   ```

2. **Reset the dialog when it opens and refresh the sale list.**

   ```ts
   useEffect(() => {
     if (!open) return;
     setMode("select");
     setSelectedSale(null);
     setSelectedItem(null);
     setError(null);
     // load recent sales here, not in a [] effect
   }, [open]);
   ```

3. **Include every unsynced return in `pendingStockByProduct()` and keep the
   delta signed.** A queue row exists only while the return is unsynced, so
   remove the status filter; remove the `Math.max(0, …)` around the subtraction
   too. Clamp only the final stock written by `fetchProducts()`:

   ```ts
   const unsyncedReturns = await db.sync_queue
     .where("entity")
     .equals("return")
     .toArray();

   // signed: a pending return can legitimately exceed the unsynced sales
   byProduct.set(
     item.product_id,
     (byProduct.get(item.product_id) ?? 0) - item.quantity,
   );
   ```

4. **Compute the pending map inside the catalogue write transaction**, and
   include every table it reads:

   ```ts
   await db.transaction(
     "rw",
     db.products,
     db.pos_sales,
     db.sync_queue,
     async () => {
       const pending = await pendingStockByProduct();
       // map rows using pending, bulkPut, delete absent products
     },
   );
   ```

   This serialises a concurrent return against the pull. A return transaction
   either commits before the map is read (so the delta is included) or waits
   until the pull commits (so it increments the freshly pulled stock).

5. **Coerce blank ids to null before the RPC.**

   ```ts
   const asUuidOrNull = (value: unknown) =>
     typeof value === "string" && value.length > 0 ? value : null;

   p_manager_id: asUuidOrNull(payload.manager_id),
   p_cashier_id: asUuidOrNull(payload.cashier_id),
   ```

6. **Make the return RPC foreign-key-safe.** Resolve optional references
   inside `pos_record_return`; never insert a UUID that does not exist:

   ```sql
   -- pos_returns: an unknown sale becomes NULL
   (SELECT s.id FROM pos_sales s WHERE s.id = p_original_sale_id)

   -- pos_return_items: an unknown product becomes NULL
   CASE
     WHEN EXISTS (
       SELECT 1 FROM products p WHERE p.id = (elem ->> 'product_id')::uuid
     )
     THEN (elem ->> 'product_id')::uuid
     ELSE NULL
   END
   ```

   This lets a return for an unpushed product or an unsynced sale still record
   its line and audit trail. It cannot restock a product the server has never
   seen; Feature C must land, or the till must push products before returns.

7. **Drop direct anon writes to returns.** In a new migration:

   ```sql
   DROP POLICY IF EXISTS "The till can record a return" ON pos_returns;
   DROP POLICY IF EXISTS "The till can record return items" ON pos_return_items;
   REVOKE INSERT ON pos_returns, pos_return_items FROM anon;
   ```

   Keep `GRANT EXECUTE` on `pos_record_return`. The function is the boundary.

**P1 — durability and audit**

8. **Add a local returns ledger** (Dexie v3):

   ```ts
   export interface LocalReturn {
     clientUuid: string;
     originalSaleUuid: string | null;
     cashierId: string | null;
     cashierName: string;
     managerId: string;
     managerName: string;
     items: { productId: string; productName: string; quantity: number }[];
     createdAt: string;
     syncedAt: string | null;
   }
   ```

   Write it in the same transaction as the stock increment and queue row. Stamp
   `syncedAt` when `pushReturn` succeeds. Then `pendingStockByProduct()` can
   derive returns from `local_returns` where `syncedAt === null`, which is more
   robust than parsing the queue payload.

9. **Prevent repeat returns.** Before recording, sum previously returned
   quantities for the same `originalSaleUuid` + `productId` and clamp the new
   return to the sold quantity. Server-side, add a check in
   `pos_record_return` or a unique/aggregate constraint.

10. **Add refund fields if money is refunded.** `refund_kes`, `refund_method`,
    `refund_reference` on `pos_returns`, and record them from the dialog. A stock
    return without a refund record is not a complete returns feature.

11. **Make the server return idempotent for duplicate lines.** Aggregate
    `p_items` by `product_id` before updating stock, or reject duplicates with a
    clear error.

### 6.7 Acceptance tests for Feature B

- Return 1 of 2 units from a sale: local stock +1, server stock +1, receipt
  line remains 2, return records quantity 1.
- Return the same line again: the UI limits the second return to the remaining
  unit, or refuses it.
- Go offline, return an item, reload, pull the catalogue manually: stock keeps
  the returned unit.
- Complete a sale, let it sync, then return one unit and refresh the catalogue
  before the return pushes: local stock still includes the returned unit.
- Force a return push failure (bad manager id / network): the queue row is
  `"error"`, local stock remains increased, a catalogue pull does not remove it,
  and the next successful sync fixes the server.
- Cancel and reopen the return dialog: it starts at “select”, not “done”.
- Approve with a cashier PIN: refused. Approve with a manager PIN: allowed.
- Approve with `9999`: refused. The demo manager PIN is `4826`.
- Direct `INSERT` into `pos_returns` with the anon key: denied.
- Return a **deactivated** product (`active = false`, row still present): the
  return records and server stock increments.
- Return a product that is missing from the server (never pushed, or
  hard-deleted): the RPC records the line with `product_id = NULL` instead of
  failing with `23503`; local stock stays correct and the audit line survives.
- Return against a sale that has not synced: the sale pushes first; if it
  cannot, the return waits or records with `original_sale_id = NULL`, never a
  hard failure.
- Two tabs: one returns, the other pulls; stock remains consistent.

---

## 7. Feature C — POS-side inventory creation (partial)

### 7.1 What exists today

- `/manager/inventory` → `app/manager/inventory/page.tsx` → `ProductForm`.
- `ProductForm` writes a `LocalProduct` and a `sync_queue` row in one Dexie
  transaction.
- `syncProducts()` pushes queued products with `pushProduct()`.
- `fetchProducts()` pulls them back (if they reached the server).
- `is_website_published` exists locally and on the server (017).

### 7.2 Creation flow in detail

`ProductForm.submit()`:

1. Builds a `LocalProduct`:
   ```ts
   {
     id: newUuid(),
     name: trimmedName,
     slug: slugify(name) || `product-${uuid.slice(0, 8)}`,
     category: "bag",          // hardcoded
     barcode: null,            // no field
     basePrice,                // parsed digits; can be 0
     discountPercent: 0,
     stockQuantity: 0,         // no field
     active: true,
     imageUrl,                 // data URL from FileReader
     updatedAt: nowIso(),
     colors,                   // names only
     isWebsitePublished,       // checkbox, default false
   }
   ```
2. Opens a Dexie transaction over `products` and `sync_queue`.
3. `db.products.add(product)`.
4. `addSyncQueueEntry({ entity: "product", entityId: product.id, payload:
   { name, slug, category, basePrice, colors, isWebsitePublished, imageUrl } })`.
5. Clears the form.

The queue payload is **not** what `pushProduct` reads. It reads the live
`products` row. The payload exists for diagnostics only.

`pushProduct()` sends:

```ts
{
  id, name, slug, category, barcode,
  base_price, base_price_usd: null,
  discount_percent, stock_quantity,
  active, is_website_published,
}
```

with `upsert(..., { onConflict: "id" })`.

### 7.3 `is_website_published` semantics

There are three layers, and they currently disagree.

| Layer | Behaviour |
| --- | --- |
| Local form | Defaults `false`; checkbox says “Will go live on the storefront” |
| Local sync push | Sends the flag in the product upsert |
| Local sync pull | Reads the server flag into `LocalProduct.isWebsitePublished` |
| Server schema | `boolean NOT NULL DEFAULT false` (017) |
| Server public-read RLS | `products` is readable when `active = true`, **regardless of `is_website_published`** |
| Storefront | Must add `is_website_published = true` to its queries; this repo does not contain that code |

Consequences:

1. **Existing catalogue backfill risk.** When 017 adds a column with
   `DEFAULT false` to a populated table, every existing product becomes
   unpublished. If the storefront starts filtering on the flag without a
   backfill, the entire website catalogue disappears.
2. **Public RLS still exposes unpublished products.** Even with the storefront
   filter, the anon key can read active-but-unpublished rows directly. If the
   flag is meant to be a publication boundary, the public read policy must
   include it — after a deliberate backfill:

   ```sql
   -- Deliberate backfill before making the flag a read boundary.
   UPDATE products SET is_website_published = true
    WHERE is_website_published = false
      AND created_at < '2026-10-23'; -- choose the cutover date
   ```

   Then, and only then, change the policy to
   `USING (active = true AND is_website_published = true)`.
3. **A POS-created product with `active = true` and `is_website_published =
   false` is still publicly readable** under the current policy, even if the
   storefront UI hides it. Treat the flag as a storefront query filter, not a
   security boundary, until the policy is changed.
4. **The checkbox is not a guarantee.** The product also needs a price, stock,
   and (for a good card) an image before it is genuinely sellable on the web.

### 7.4 The current blockers

#### C1 — anon cannot write `products`

`001_initial.sql` grants `INSERT/UPDATE/DELETE` on `products` only to
`authenticated`. The POS client uses the anon key with no auth session.
`pushProduct()` therefore fails with RLS error `42501`. Every sync run marks the
product queue row as `"error"` and retries forever.

#### C2 — the next catalogue pull deletes the local product

`fetchProducts()` deletes every local product whose id is not in the server
response. A product that failed to push is not on the server, so it is deleted
locally on the next pull. The manager’s product disappears, along with the
queue row’s referent (`syncProducts` then deletes the queue row as stale).

This is a **data-loss path**: create a product while offline or while the push
is failing, then refresh the catalogue → the product is gone.

#### C3 — local fields are overwritten on pull

Even if the push succeeds, the pull maps:

- `colors: []` — the manager’s selected colour names are lost.
- `imageUrl` from `product_images` — the local data URL is replaced by `null`
  because the POS never writes `product_colors` / `product_images`.
- `stockQuantity` from `server - pending` — any local-only stock change is lost
  (there is no local stock editor yet, but there will be).

#### C4 — new products are not sellable

`stockQuantity: 0` and `category: "bag"` are hardcoded. The grid disables
out-of-stock products, so a freshly created product cannot be sold until stock
is somehow increased (there is no UI to do that). Shoes cannot be created.

#### C5 — price can be zero

`canSubmit` requires `name.trim().length >= 2`, `basePrice >= 0`, and
`colors.length > 0`. An empty price parses to 0 and is accepted. A zero-price
product is a free product.

#### C6 — slug collisions

`slugify(name)` is not checked for uniqueness. `products.slug` is `UNIQUE`.
A duplicate name produces a `23505` error, the queue row retries forever, and
the manager sees no explanation.

#### C7 — image data URLs bloat IndexedDB and the queue

`FileReader.readAsDataURL` stores the full image as a base64 string in
`products.imageUrl` **and** in the queue payload. A 5 MB photo becomes ~6.7 MB
of UTF-16-ish string data, twice. This risks quota errors and slows every
catalogue read. The image is never uploaded to Supabase.

#### C8 — barcode is always null

There is no barcode field. A POS-created product cannot be scanned. The partial
unique index on `products.barcode` is never exercised.

#### C9 — `base_price_usd: null` on push

If a product is later edited in the admin and assigned a USD price, a re-push
would null it. Since the POS only pushes once at creation, this is latent, but
the upsert should omit `base_price_usd` rather than explicitly null it.

### 7.5 Recommended fix plan for Feature C

**P0 — restore a safe write path**

1. **Add a narrow `SECURITY DEFINER` RPC** in a new migration
   `019_pos_product_creation.sql`. Do not open `products` to anon writes.

   ```sql
   CREATE OR REPLACE FUNCTION pos_create_product(
     p_id uuid,
     p_name text,
     p_slug text,
     p_category text,
     p_barcode text,
     p_base_price integer,
     p_discount_percent integer,
     p_stock_quantity integer,
     p_is_website_published boolean
   )
   RETURNS boolean
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = public
   AS $$
   BEGIN
     IF p_name IS NULL OR length(trim(p_name)) < 2 THEN
       RAISE EXCEPTION 'A product needs a name' USING ERRCODE = 'check_violation';
     END IF;
     IF p_base_price IS NULL OR p_base_price <= 0 THEN
       RAISE EXCEPTION 'A product needs a positive price' USING ERRCODE = 'check_violation';
     END IF;
     IF p_category NOT IN ('bag', 'shoe') THEN
       RAISE EXCEPTION 'Unknown category %', p_category USING ERRCODE = 'check_violation';
     END IF;
     IF p_stock_quantity IS NULL OR p_stock_quantity < 0 THEN
       RAISE EXCEPTION 'Stock cannot be negative' USING ERRCODE = 'check_violation';
     END IF;

     INSERT INTO products (
       id, name, slug, category, barcode,
       base_price, discount_percent, stock_quantity,
       active, is_website_published
     )
     VALUES (
       p_id, trim(p_name), p_slug, p_category, p_barcode,
       p_base_price, coalesce(p_discount_percent, 0), p_stock_quantity,
       true, coalesce(p_is_website_published, false)
     )
     ON CONFLICT (id) DO NOTHING;

     RETURN FOUND;
   END;
   $$;

   REVOKE ALL ON FUNCTION pos_create_product(
     uuid, text, text, text, text, integer, integer, integer, boolean
   ) FROM PUBLIC;
   GRANT EXECUTE ON FUNCTION pos_create_product(
     uuid, text, text, text, text, integer, integer, integer, boolean
   ) TO anon, authenticated;
   ```

   Insert-only is deliberate: it is idempotent on retry and cannot clobber a
   stock count that another till or the storefront has changed. Product editing
   is a separate feature with its own RPC.

2. **Make the slug collision-proof.** Either:
   - check `slug` before insert and append `-<short id>` on conflict, or
   - let the RPC catch `unique_violation` and retry with a suffix.

   A product must never sit in the queue forever because of a name.

3. **Update `pushProduct()` to call the RPC** instead of `products.upsert`.
   Add the function to `lib/supabase/types.ts`.

4. **Do not delete local products with a pending product queue entry.**
   Inside `fetchProducts`’ transaction, read pending product ids and exclude
   them from the `noneOf(ids).delete()`:

   ```ts
   const pendingProductIds = new Set(
     (await db.sync_queue.where("entity").equals("product").toArray())
       .map((entry) => entry.entityId),
   );
   const deletable = ids.length === 0
     ? await db.products.toCollection().primaryKeys()
     : await db.products.where("id").noneOf(ids).primaryKeys();
   const toDelete = deletable.filter((id) => !pendingProductIds.has(id));
   await db.products.bulkDelete(toDelete);
   ```

   Include `sync_queue` in the transaction scope.

5. **Preserve local-only fields on pull.** For rows backed by a pending product
   queue entry, merge `colors`, local `imageUrl`, and local `isWebsitePublished`
   into the mapped row instead of overwriting them. Long term, persist colours
   and images server-side so the merge is only a migration aid.

**P1 — make the form complete**

6. **Add fields:** category (`bag`/`shoe`), opening stock (integer ≥ 0),
   optional barcode, and a positive price requirement (> 0).
7. **Enforce price > 0** in both the form and the RPC.
8. **Resize images before storing.** Use a canvas to cap the long edge at
   ~1200px and encode as WebP/JPEG. Store a `Blob` in a separate Dexie table or
   a single data URL, but **never** duplicate it into the queue payload.
9. **Remove `imageUrl` from the product queue payload.** `pushProduct` does not
   use it, and it doubles storage.
10. **Do not advertise an image as published until it is uploaded.** Either:
    - keep images local-only and label them as such in the manager UI, or
    - add a signed-upload edge function (recommended: the storage bucket is
      authenticated-only, so the POS cannot upload directly with the anon key).

**P2 — colours and media**

11. **Persist colours.** The storefront schema expects `product_colors`
    (`color_name`, `color_hex`, `sort_order`). The POS form only has names.
    Either:
    - add a name → hex lookup with a deterministic fallback, and insert colour
      rows in the RPC, or
    - keep colours local-only and stop implying they are saved.
12. **Add `pos_product_images` or an upload path** if POS-created products must
    have storefront photography. A data URL in IndexedDB is not a website image.

### 7.6 `is_website_published` safe rollout

1. Apply 017.
2. **Backfill existing products** to `true` if they are meant to stay live.
3. Deploy the storefront query filter (`is_website_published = true`).
4. Optionally tighten the public read policy in a later migration.
5. Only then allow POS-created products to set the flag.

Do not reverse steps 2 and 3. Doing so takes the shop offline.

### 7.7 Acceptance tests for Feature C

- Create a bag with name, positive price, one colour, opening stock 5.
- It appears in the till grid immediately, in stock, and can be sold offline.
- The queue row is `"product"`; a failed push leaves it `"error"` and the
  product remains after a manual catalogue refresh.
- With the RPC applied, the product uploads; the queue row disappears.
- Re-run sync: no duplicate product, no stock reset.
- Create a shoe: stored as `shoe`, reported as a shoe in daily totals.
- Create with a duplicate name: the product still gets a unique slug and syncs.
- Create with price 0: form refuses; RPC refuses if called directly.
- Create with stock 0: product appears out of stock, cannot be added to cart.
- Publish one product: storefront shows it only after the flag/filter rollout.
- Unpublish one: existing catalogue remains visible (backfill verified).
- Upload a 5MB photo: IndexedDB usage is bounded; the UI does not freeze; the
  queue payload does not contain the data URL.
- Barcode: a POS-created product with a barcode scans and adds to the cart.
- Direct `INSERT` into `products` with the anon key: denied; only the RPC works.
- `base_price_usd` on an existing product is not nulled by a POS re-push.

---

## 8. Risk assessment and “do not break” checklist

### 8.1 Risk register

Severity: **C**ritical / **H**igh / **M**edium / **L**ow.

| ID | Risk | Sev | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| R01 | `9999` bypass in login and `verifyPin` | C | Anyone becomes manager; fake non-UUID cashier id breaks sale sync | Remove both bypasses; rotate manager hash; remove logs (§4.4) |
| R02 | `pushProduct` uses anon against RLS-protected `products` | C | Product sync always fails; next pull deletes the local product | Add `pos_create_product` SECURITY DEFINER RPC; never open table writes |
| R03 | `fetchProducts` deletes local products absent from server | C | Data loss for any pending/failed product | Exclude pending product ids from deletion; merge local fields |
| R04 | Catalogue pull computes pending stock outside the write transaction | H | Concurrent sale/return is overwritten by the pull | Move the pending snapshot inside the Dexie transaction over products + pos_sales + sync_queue |
| R05 | `pendingStockByProduct` ignores `"error"` returns | H | A failed return’s stock increment disappears on refresh | Include all return queue rows, not only `"pending"` |
| R06 | Return quantity is ignored | H | Wrong stock, wrong customer refund, over-return | Pass `quantity` through `ConfirmReturn` → `handleConfirm` → `recordReturn` |
| R07 | No record of already-returned units | H | Repeat returns inflate stock and refund twice | Add local returns ledger; clamp against original sale line; server check |
| R08 | Direct anon INSERT on returns | H | Return rows can be written without stock update | Drop policies/grants; RPC only |
| R09 | `is_website_published` defaults false on existing rows | H | Storefront catalogue can disappear if filtering ships first | Backfill before deploying the storefront filter |
| R10 | Serial write awaited in cashier path | H | A slow/unplugged VFD freezes checkout | All display calls fire-and-forget with latest-wins; never await |
| R11 | VFD constructor touches `navigator.serial` during SSR | M | Build/render crash | Lazy singleton behind `useEffect` / client guard |
| R12 | PIN/hash logging | H | Credential leak via DevTools/remote logs | Remove all credential logs |
| R13 | Receipt email has no idempotency and no auth | M | Duplicate emails; open relay if webhook is public | Add a delivery id, rate limit/auth, or provider idempotency key |
| R14 | Image data URL duplicated into queue and Dexie | M | Quota exhaustion; slow reads | Resize, store once, remove from payload |
| R15 | Return dialog does not reset / stale sales list | M | Second return starts on “done”; returns against stale data | Reset on open; reload sales in an `[open]` effect |
| R16 | `applyReturnLocally` is unused and non-atomic | L | Future misuse can double-apply stock | Delete it or replace with ledger replay |
| R17 | Multiple tabs run `runSync` concurrently | L | Duplicate receipt emails; transient stock drift | Server idempotency covers money; add a cross-tab lock if needed |
| R18 | No automated tests | M | Regressions in money/stock math | Add Vitest for `lib/cart.ts`, `lib/sales.ts`, `lib/time.ts`, pending-stock pure logic |
| R19 | Dexie schema change done wrong | H | Upgrade failure on a live till | Only add stores; repeat full index strings; test populated v2 → v3 |
| R20 | Storage eviction / no persistent storage request | M | IndexedDB cleared, unsynced sales lost | Call `navigator.storage.persist()` after first sale; document export/backup |
| R21 | Service worker serves stale shell after deploy | L | New feature missing offline | Serwist revision from git HEAD; verify `public/sw.js` after build |
| R22 | Manager PIN gate is client-side only | H | Anon can call privileged RPCs directly | Accept as Phase 1 boundary or add device tokens/server sessions |
| R23 | Product form allows price 0 / no stock / no category | M | Unsellable or free products | Validate price > 0; add stock/category fields |
| R24 | Slug collision retries forever | M | Product never syncs, no explanation | Unique slug strategy + readable error |
| R25 | VFD shows payment reference | M | Card/M-Pesa code exposed to customer | Never paint references; only method and amount |
| R26 | Return delta clamped at 0 in the pending map | H | A return rung up after its sale synced is erased by the next catalogue pull | Keep the net delta signed; clamp only the final local stock |
| R27 | Catalogue pull is unpaginated | M | Above the PostgREST row cap, the “absent from response” delete removes valid local products | Page the select; delete only after the final page |
| R28 | Return RPC trusts sale/product foreign keys | H | Returns fail (`23503`) for unpushed products or unsynced sales, so stock never returns | Null unknown references server-side; resolve optional UUIDs on the client |

### 8.2 Ensuring the VFD never blocks the cashier UI

Non-negotiable rules:

1. **No `await` on serial I/O in a click handler, sale path, or Dexie
   transaction.** `paint()` returns `void`.
2. **One write in flight, latest frame wins.** The `flush()` loop consumes
   `latestFrame` and drops older frames. A 9600-baud device cannot build a
   backlog.
3. **Never construct the display during render or SSR.** The library constructor
   calls `navigator.serial.addEventListener`.
4. **Never prompt on page load.** `requestPort()` only from the “Connect
   display” button. `reconnect()` may run on mount because it uses already
   granted ports.
5. **Catch every write error.** A pulled cable sets status, not an exception in
   the sale path.
6. **Do not put the display inside `completeSale` or the checkout transaction.**
   Paint after the local commit.
7. **Do not make the display a dependency of the cart reducer or totals.** It is
   an output device, not state.
8. **Keep the control out of the critical tap path.** A small pill/button, never
   a modal that covers the Charge button.
9. **Feature-detect.** `"serial" in navigator` plus a secure context. Unsupported
   browsers see no control.
10. **Test with a deliberately slow device.** The UI must remain responsive while
    the VFD is writing.

### 8.3 Ensuring a return or new product is never lost offline

The durability chain must be:

```text
Dexie transaction {
  entity row
  local stock change (if any)
  sync_queue row (pending)
}
→ commit
→ UI updates
→ (later) push
```

Rules:

1. **Never write the entity and the queue row in separate transactions.**
   `completeSale`, `recordReturn`, and `product-form` already do this correctly.
   Keep it that way.
2. **Never delete the queue row before the local entity is durable.** For sales,
   stamp `syncedAt` first, then delete. For products, the product row already
   exists. For returns, the queue row is the only record — do not delete it
   until the server acknowledges.
3. **Never treat an empty server response as “delete everything”.**
   `fetchProducts` currently clears the catalogue when the server returns zero
   rows. That is correct for an empty catalogue, but dangerous during an auth
   or RLS failure that returns `[]` with no error. Add a guard: if the request
   succeeded but returns zero and the local catalogue is non-empty, keep the
   local rows and record a notice.
4. **Never delete a local product with a pending product queue row.**
5. **Never recompute pending stock from a stale snapshot.** Read it inside the
   write transaction.
6. **Persist the queue across reloads.** It is IndexedDB, so it already
   survives. Do not add an in-memory queue.
7. **Request persistent storage** (optional but recommended):
   ```ts
   if (navigator.storage?.persist) void navigator.storage.persist();
   ```
   Do this after the first successful sale, not on page load, so the browser
   grants it to an app the user actually uses.
8. **Test the crash window:** create a sale/return/product, immediately kill the
   tab (DevTools → Application → Clear site data is a different test), reopen,
   verify the queue row and local stock survived.
9. **Test offline creation then online sync:** airplane mode → create → reload →
   online → sync → server row exists exactly once.
10. **Test a failed push:** force an RLS/network error, then pull the catalogue
    manually. The local entity must remain and the queue row must remain
    `"error"`.

### 8.4 The `9999` removal checklist

- [x] Generate a real bcrypt hash for the manager PIN with cost 10.
- [x] Update the seeded manager (`018_pos_rotate_demo_manager_pin.sql`).
- [x] Remove the `candidate === "9999"` branch from `pin-login.tsx`.
- [x] Remove the hardcoded hash from `verifyPin` in `lib/auth.ts`.
- [x] Remove all PIN/hash/roster `console.log`s.
- [x] Delete `SupabaseConnectionCheck` and its `/login` mount.
- [x] Confirm every session id is a real UUID (the fabricated id is gone).
- [ ] Confirm `9999` fails on a database that has run `018`.
- [ ] Confirm `4826` signs in as the demo manager, online and offline.
- [ ] Confirm a manager sale syncs (no invalid UUID error).
- [ ] Confirm a cashier cannot approve a return with their own PIN.
- [ ] Rotate demo PINs before production.
- [x] Add the manual QA steps to the release checklist.

### 8.5 Do-not-break checklist for every PR

**Data and sync**

- [ ] Every new local write is one Dexie transaction containing the entity,
      stock change, and queue row.
- [ ] Every new push has an idempotency key and deletes the queue row only after
      success.
- [ ] Every push failure calls `recordFailure` and leaves the row retryable.
- [ ] No cashier path calls `fetch`, `await` a network call, or opens a serial
      port.
- [ ] `runSync` order remains money/stock before catalogue.
- [ ] `pendingStockByProduct` still accounts for every unsynced sale and return,
      and keeps a signed net delta (a pending return may make it negative).
- [ ] A catalogue pull cannot delete a pending local entity.
- [ ] A pull’s pending snapshot is read inside the same transaction as the write.
- [ ] `fetchProducts` does not clear a non-empty catalogue on an empty/error
      response without a guard.

**Schema**

- [ ] Dexie version bumped; existing stores repeated if indexes changed.
- [ ] Tested upgrade from a populated v2 database.
- [ ] Supabase migration is additive and idempotent.
- [ ] POS-owned migrations are `012+`; storefront `001–011` untouched.
- [ ] New RPC is `SECURITY DEFINER`, `SET search_path = public`, revoked from
      `PUBLIC`, granted only to the intended roles.
- [ ] No new broad anon table write policies.

**Auth and security**

- [ ] No hardcoded PIN, bypass, or fake user id.
- [ ] No PIN/hash/roster logging.
- [ ] Session ids are UUIDs.
- [ ] Manager-only UI is still backed by the layout guard.
- [ ] Privileged operations do not rely on the client-side role check alone.

**UI**

- [ ] New device APIs are client-only and in effects.
- [ ] Loading, empty, error, and offline states are present.
- [ ] Focus is visible; dialogs trap and restore focus.
- [ ] `prefers-reduced-motion` is respected.
- [ ] No blocking modal for a non-critical device (VFD).
- [ ] Payment references are never shown on the customer display.

**Build and QA**

- [ ] `pnpm lint`
- [ ] `pnpm build`
- [ ] `test -f public/sw.js && echo "service worker written"`
- [ ] Offline manual run: sign in, sell, return, create product, reload, sync.
- [ ] Failed-push manual run: local entity survives, queue shows error, retry
      succeeds.
- [ ] Two-tab run: no duplicate sale/return, no lost stock.

### 8.6 Manual QA matrix

| Scenario | Steps | Expected |
| --- | --- | --- |
| Offline sale | Network offline → add items → cash → complete | Sale in `pos_sales`, stock reduced, queue `sale` pending, receipt prints |
| Online sync | Go online / Sync now | Queue drains, `syncedAt` set, server rows exist once |
| Replay | Throttle/duplicate a push | Server returns `false`, no duplicate row, no double stock |
| Offline return | Offline → return 1 unit | Local stock +1, queue `return` pending |
| Pull during pending return | Offline return → online → Refresh catalogue before sync | Stock keeps +1 (`pendingStockByProduct`) |
| Pull after synced sale | Sell 1 (sync) → return 1 → Refresh catalogue before the return syncs | Stock keeps +1; not reset by the pull |
| Failed return | Force RPC error | Queue `error`, stock stays +1, pull keeps +1 |
| Product create offline | Offline → create product | Local product visible, queue `product` pending |
| Pull during pending product | Offline create → online → Refresh catalogue | Product still present; not deleted |
| Failed product push | Force RLS error | Queue `error`, product remains, clear error surfaced |
| Publish backfill | Apply 017 → storefront filter | Existing catalogue still visible |
| VFD connect | Click Connect → choose port | `connected`, welcome frame |
| VFD unplug | Pull cable → complete sale | Sale succeeds, display status error, no UI freeze |
| 9999 | Type `9999` on the login keypad | Refused; the demo manager PIN is `4826` |
| Cashier return approval | Cashier PIN in return dialog | Refused |
| Manager sale | Manager sale → sync | No invalid UUID error |
| Direct anon writes | Insert into `products`, `pos_returns` | Denied |

---

## 9. Implementation sequencing

Recommended order, smallest safe PRs first:

### Phase 0 — stop the bleeding (one PR)

1. Remove the `9999` bypass and all credential logging (§4.4).
2. Fix the return quantity bug and dialog reset (§6.6 B1–B3).
3. Include `"error"` returns in `pendingStockByProduct` and keep its net delta
   signed (§6.6 B4, B12).
4. Move the pending snapshot inside the catalogue transaction (§6.6 B5).
5. Add the “empty server response” guard to `fetchProducts`.
6. Add unit tests for `lib/cart.ts`, `calculateTotals`, and the pending-stock
   math.

**Why first:** these are small, local, and remove the highest-probability
money/stock bugs before any new feature adds more state.

### Phase 1 — server boundaries

1. Start `019_pos_product_creation.sql` with `pos_create_product` and the
   `is_website_published` backfill plan.
2. Make `pos_record_return` foreign-key-safe for unknown sale/product ids
   (§6.6).
3. Drop direct anon INSERT policies on `pos_returns` / `pos_return_items`.
4. Update `lib/supabase/types.ts` for the new RPC.
5. Add an RLS test script that runs as `anon`: product insert denied, RPC
   allowed, direct return insert denied, RPC allowed.

**Status:** items 1–5 are implemented in `019_pos_product_creation.sql`,
`lib/supabase/types.ts` and `supabase/tests/phase1_server_boundaries.sql`.
Run the boundary checks with `pnpm test:rls` (local Supabase must be running).
`pushProduct` still uses the old direct upsert until Phase 2.

### Phase 2 — Feature C complete

1. Update `pushProduct` to call the RPC.
2. Add pending-product protection and field merging to `fetchProducts`.
3. Add category, stock, barcode, and positive-price validation to the form.
4. Resize images; remove the data URL from the queue payload.
5. Decide the colours/media story (local-only vs. persisted).

### Phase 3 — Feature B complete

1. Add the local returns ledger (Dexie v3).
2. Prevent repeat/over-returns.
3. Add refund amount/method if money is refunded.
4. Add server-side duplicate-line aggregation and quantity validation.
5. Add a returns view to the manager dashboard (optional).

### Phase 4 — Feature A VFD

This is independent of Phases 0–3 and can run in parallel by one engineer. It
touches only `lib/customer-display.ts`, the hook, the control component, and
paint calls in `pos-screen.tsx` / `checkout-dialog.tsx`. It does not touch Dexie
or `lib/sync.ts`.

**Do not merge a VFD change that alters the sale transaction, the queue, or the
checkout confirmation flow.** If a display change needs those, the design is
wrong.

---

## 10. File ownership map

| Concern | Owner |
| --- | --- |
| Route guard | `components/require-auth.tsx` |
| Session, PIN hashing | `lib/auth.ts` |
| Auth React context | `components/auth-provider.tsx`, `hooks/use-auth.ts` |
| Local schema and types | `lib/db.ts` |
| Sale recording and totals | `lib/sales.ts` |
| Cart rules | `lib/cart.ts` |
| Return recording | `lib/returns.ts` |
| Cash drawer | `lib/till.ts` |
| Cashier enrolment | `lib/staff.ts` |
| Sync engine and outbox | `lib/sync.ts` |
| Sync React store | `hooks/use-sync-state.ts` |
| Catalogue React store | `hooks/use-products.ts` |
| Supabase client | `lib/supabase/client.ts` |
| Supabase type subset | `lib/supabase/types.ts` |
| Receipt email API | `app/api/pos/receipt-email/route.ts` |
| PWA manifest | `app/manifest.ts` |
| Service worker | `app/sw.ts` |
| Print rules | `app/globals.css` |
| Receipt layout | `components/pos/receipt.tsx` |
| Checkout UI | `components/pos/checkout-dialog.tsx` |
| POS orchestration | `components/pos/pos-screen.tsx` |
| Returns UI | `components/pos/return-dialog.tsx`, `components/pos/return-pin-dialog.tsx` |
| Product creation UI | `components/manager/product-form.tsx` |
| Customer display (planned) | `lib/customer-display.ts`, `hooks/use-customer-display.ts`, `components/pos/customer-display-control.tsx` |
| DB policies/RPCs | `supabase/migrations/012–018` (019 planned) |

---

## 11. Glossary

| Term | Meaning |
| --- | --- |
| **Outbox** | `sync_queue`: local facts not yet acknowledged by Supabase |
| **Pending delta** | Units sold locally but not synced, minus units returned locally but not synced |
| **Idempotency key** | A client-generated UUID that lets a retry be a no-op |
| **Pull** | Reading server catalogue/roster into Dexie |
| **Push** | Sending a queued local fact to Supabase |
| **EAT** | East Africa Time (UTC+3), the day boundary used by reports |
| **SECURITY DEFINER** | A Postgres function that runs with its owner’s privileges, bypassing the caller’s RLS; the narrow boundary used for POS writes |
| **Anon** | The Supabase role used by the browser’s publishable key; no auth session |
| **VFD** | Vacuum fluorescent display; the 2×20 customer-facing screen |

---

## 12. Bottom line

The till’s offline-first core is sound: Dexie is the source of truth for the
shift, the queue is a durable outbox, and sales/returns are idempotent on the
server. The current risks are concentrated in four places:

1. **The `9999` bypass and credential logging** — remove immediately.
2. **Return correctness** — quantity, repeat returns, error-status stock, and
   the pull race.
3. **Product creation** — the anon RLS blocker and the destructive catalogue
   pull.
4. **Any new device integration** — keep serial I/O off the cashier path.

Feature A is additive and low-risk if it follows §5. Features B and C are
already partially built; finish their correctness work before adding new
surface area. The fastest way to lose money on this till is to let a pull,
a failed push, or a blocking device call overwrite something the cashier has
already done.
