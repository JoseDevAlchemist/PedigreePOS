# Pedigree POS — Codebase Analysis Report

**Analysed:** 31 October 2026
**Repository:** `/home/jose/configs/Desktop/pedigreepos`
**Branch:** `feature-toasts-and-login-fix`
**HEAD:** `191ce41 Add manager settings, stock adjustments, and discounts`
**Working tree at analysis time:** clean (before this report was created)

---

## 1. Executive summary

Pedigree POS is a desktop-first, offline-first point-of-sale PWA for a Nairobi leather workshop. It is built with Next.js 16 (App Router, webpack), React 19, TypeScript, Tailwind CSS v4, Dexie/IndexedDB, and Supabase. The core design is local-first: every sale, return, cash-drawer shift and stock correction is written to IndexedDB first and pushed to Supabase later through an idempotent sync queue. The app is designed to keep selling through a dropped connection.

The implementation is unusually well documented and the core money paths are thoughtfully designed: atomic Dexie transactions, idempotent server RPCs, stock reconciliation that accounts for unsynced sales, manager-approved returns, and an offline-capable PIN sign-in.

The main risks are not in the core sale path. They are at the edges:

1. **The M-Pesa integration does not match the documented Safaricom Daraja API shape or callback payload.** The UI falls back to manual code entry, which masks the integration gap.
2. **The new manager settings screen writes with the anon key against RLS policies that require `authenticated`**, so saving the exchange rate and adding discounts will fail.
3. **Stock-adjustment sync ignores Supabase RPC errors** and can lose a queued adjustment; pending adjustments are also not included in catalogue stock reconciliation.
4. **The auth boundary is explicitly a convenience boundary**, not a security boundary. PIN hashes are readable with the public anon key, and the role check is editable client state.
5. **Several new screens are partly integrated**: `/manager/settings` is missing from the manager navigation, and the inventory page nests two independently laid-out components.

Verification status:

| Check | Result |
| --- | --- |
| `pnpm lint` | Passed (exit 0) |
| `npx tsc --noEmit` | Passed (exit 0) |
| `pnpm build` | Passed (exit 0); all 15 routes generated, service worker bundled |
| `git status` | Clean before this report; no stashes, no tags |

---

## 2. Technology stack and build

| Concern | Choice |
| --- | --- |
| Framework | Next.js `16.4.2` (App Router) |
| UI | React `19.3.0`, Tailwind CSS v4, `lucide-react`, `framer-motion` |
| Language | TypeScript 5, strict mode |
| Local database | Dexie `4.4.6` + `dexie-react-hooks` |
| Server | Supabase (`@supabase/supabase-js`) |
| Offline/PWA | Serwist `9.5.13` (`@serwist/next`) |
| Auth hashing | `bcryptjs` |
| Hardware | Web Serial customer display, USB barcode/QR scanner |
| Package manager | pnpm `12.9.1` |

Build notes:

- `pnpm dev` and `pnpm build` deliberately use `--webpack`. Serwist is a webpack plugin, so Turbopack would silently ship a build with no service worker.
- `next.config.ts` enables `cacheComponents`, `partialPrefetching`, and Serwist precaching. The offline shell is at `/~offline`.
- The Web Serial package only publishes a `browser` export condition, so `next.config.ts` adds `browser` to webpack `resolve.conditionNames`.
- `images.remotePatterns` allows Supabase public storage URLs for the local logo next/image; product cards use plain `<img>` so the browser cache works offline.

Build output routes:

```text
/                       static
/_not-found             static
/~offline               static
/api/pos/mpesa/callback dynamic
/api/pos/mpesa/stk-push dynamic
/api/pos/receipt-email  dynamic
/icon.png               static
/login                  static
/manager                static
/manager/inventory      static
/manager/settings       static
/manager/staff          static
/manifest.webmanifest   static
/pos                    static
```

---

## 3. Architecture and data flow

```text
Cashier action
     |
     v
React UI  ──>  Dexie / IndexedDB  ──>  UI updates immediately
                    |
                    |  sync_queue row
                    v
               runSync()
                    |
                    v
               Supabase RPCs / REST
                    |
                    +──> /api/pos/receipt-email ──> POS_RECEIPT_EMAIL_WEBHOOK
```

Key architectural decisions:

- **IndexedDB is the operational database.** Supabase is a best-effort mirror, not the source of truth for the current shift.
- **Push before pull.** Money already taken is higher priority than a fresher catalogue.
- **Idempotency lives on the server.** Sales, products and returns are keyed by client-generated UUIDs and inserted with `ON CONFLICT DO NOTHING`-style guards inside `SECURITY DEFINER` RPCs.
- **Navigation is deliberately hard.** Plain `<a href>` and `window.location.replace` are used for offline-critical navigation, because a service-worker-cached document request works without a server, while a Next client navigation would need an RSC payload.
- **Auth is client-side by design.** The session lives in `localStorage`; route guards are client components because middleware would fail exactly when the till is offline.

---

## 4. Feature inventory and implementation

### 4.1 Offline-first PWA shell

**Files:** `next.config.ts`, `app/sw.ts`, `app/manifest.ts`, `app/~offline/page.tsx`, `components/offline-shell.tsx`, `app/layout.tsx`

- Serwist precaches the app shell and uses `defaultCache` for runtime caching.
- Document requests that miss the cache while offline fall back to `/~offline`.
- `app/manifest.ts` defines a standalone PWA with 192/512/maskable icons and `start_url: "/pos"`.
- The root route `/` redirects to `/pos`; `/pos` handles the not-signed-in case itself.
- `cacheComponents` keeps route shells static so they are available before the first offline load.

### 4.2 Local database

**File:** `lib/db.ts`

Dexie database `pedigree-pos` with five schema versions:

| Version | Change |
| --- | --- |
| 1 | `products`, `pos_sales`, `pos_users`, `sync_queue` |
| 2 | `till_sessions` |
| 3 | `local_returns`, with migration of pending return queue payloads into the ledger |
| 4 | `qrCode` index on `products` |
| 5 | `pos_discounts` |

Tables:

| Table | Key | Purpose |
| --- | --- | --- |
| `products` | `id` | Catalogue, local stock, image, colours, QR code |
| `pos_sales` | `clientUuid` | Sales with embedded line items |
| `local_returns` | `clientUuid` | Durable local return/refund ledger |
| `pos_users` | `id` | Staff roster with bcrypt PIN hashes |
| `sync_queue` | `++id` | Work owed to the server |
| `till_sessions` | `++id` | Cash-drawer shifts |
| `pos_discounts` | `id` | Locally cached discount codes |

Sale and return lines are embedded in the parent row locally, so a parent and its lines are written atomically. On the server they are normalised into `pos_sale_items` / `pos_return_items`.

### 4.3 PIN sign-in and session

**Files:** `components/auth/pin-login.tsx`, `lib/auth.ts`, `components/auth-provider.tsx`, `hooks/use-auth.ts`, `components/require-auth.tsx`, `components/auth/brand-panel.tsx`

- Staff sign in with a 4-digit PIN on a custom keypad.
- The PIN is checked against the locally cached roster (`pos_users`) using bcrypt. This allows sign-in with no network after the roster has been cached once.
- There is no user picker: the first active roster entry whose hash matches wins.
- Five failed attempts trigger a 30-second lockout.
- The session is stored in `localStorage` under `pedigree-pos.session` as `{ id, name, role, loggedInAt }`.
- `AuthProvider` exposes the session through `useSyncExternalStore`, so cross-tab sign-out works via the `storage` event.
- `RequireAuth` is a client component. It renders a splash until the session is hydrated, then redirects with `window.location.replace`.
- `/manager` and everything below it are guarded by `app/manager/layout.tsx` with `role="manager"`.

> The role check is a convenience boundary. A user with DevTools can edit `localStorage` and become a manager. This is documented in the code and is not a server-enforced security boundary.

### 4.4 Catalogue, search and scanning

**Files:** `components/pos/pos-screen.tsx`, `components/pos/product-grid.tsx`, `hooks/use-products.ts`, `hooks/use-barcode-scanner.ts`

- `useProducts()` uses `useLiveQuery` so the catalogue updates live when a sync lands.
- The grid shows image, name, category, price, discount, and stock status.
- Text search matches name, slug, barcode, QR code and category.
- Exact code lookup resolves **barcode → QR code → slug**, case-insensitively.
- The scanner hook treats a USB scanner as a fast keyboard ending in Enter:
  - it ignores editable targets and open modal dialogs;
  - it buffers printable characters and resets after a 120 ms gap;
  - it requires at least 4 characters;
  - it can add a product globally or resolve an exact barcode typed into the search box.
- QR codes are captured by the same character-based scanner path, not only numeric barcodes.

### 4.5 Cart and totals

**Files:** `lib/cart.ts`, `components/pos/cart-panel.tsx`, `lib/sales.ts`

- The cart is a pure reducer: `add`, `increment`, `decrement`, `setQuantity`, `remove`, `clear`, `setDiscount`, `reset`.
- A product is a line, not a row: scanning the same product increments quantity.
- Quantities are clamped to local stock, never below one; decrementing to zero removes the line.
- `calculateTotals()` computes subtotal, discount and total in one place, rounding to whole shillings once at the end.
- The cart supports a fixed 10% preset and discount codes looked up in the local `pos_discounts` table.

### 4.6 Taking payment

**Files:** `components/pos/checkout-dialog.tsx`, `lib/sales.ts`, `lib/format.ts`

Three payment methods:

| Method | Behaviour |
| --- | --- |
| **Cash** | Numeric tender input, quick-tender buttons (1000/500/200/100), live change-due or short-by display, confirm disabled until tender covers the total. |
| **M-Pesa** | Optional STK push to the customer's phone; always retains a manual confirmation-code fallback. |
| **Card** | Free-text card terminal reference, minimum 4 characters, stored against the sale. |

`completeSale()`:

1. Rejects an empty basket.
2. Calculates totals.
3. Creates a `LocalSale` with a fresh `clientUuid` and a UUID per line.
4. Writes the sale, decrements local stock (never below zero), and appends a `sync_queue` row in **one Dexie transaction**.
5. Refreshes the pending count.
6. Returns the sale so the receipt dialog can open.

No network call is awaited. A crash after the transaction still leaves the sale on disk.

### 4.7 M-Pesa STK Push (Lipa Na M-Pesa)

**Files:** `lib/mpesa.ts`, `app/api/pos/mpesa/stk-push/route.ts`, `app/api/pos/mpesa/callback/route.ts`, `components/pos/checkout-dialog.tsx`, `lib/logger.ts`

- Credentials are server-side only: `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY`, `MPESA_SHORTCODE`, `MPESA_CALLBACK_URL`, `MPESA_ENV`.
- The browser posts `{ amountKes, phoneNumber, accountReference }` to `/api/pos/mpesa/stk-push`.
- The route validates amount and normalises Kenyan phone numbers (`07XXXXXXXXX` or `2547XXXXXXXXX`).
- The server client caches an OAuth token, builds the shortcode/passkey/timestamp password, and calls the configured STK push endpoint.
- The callback route parses the result, logs success/failure, and returns the result code plus confirmation code.
- The checkout UI has phases `idle → sending → waiting → manual`. If the prompt cannot be sent, it automatically falls back to manual code entry so a sale cannot dead-end.

**Current limitation:** the till does not poll or receive the callback result. `waiting` only tells the cashier the prompt was sent; to finish the sale, the cashier must switch to manual entry and type the code. The callback route currently logs the result and returns it to the caller, but it does not persist or associate the payment with a sale.

### 4.8 Receipts, printing and receipt email

**Files:** `components/pos/receipt.tsx`, `components/pos/receipt-dialog.tsx`, `app/api/pos/receipt-email/route.ts`, `app/globals.css`, `lib/sales.ts`

- The receipt is rendered from the stored sale, not the live cart.
- It is an 80mm thermal layout, black on white, with store header, receipt id, EAT date/time, cashier, line items, subtotal, discount, total, payment method, tendered/change or payment reference, and footer.
- Printing uses `window.print()`. The receipt modal is portalled to `document.body`; print CSS hides everything except `.print-root` and the receipt.
- `@page { size: 80mm 297mm; margin: 0 }` selects roll paper.
- Email is always queued locally (`queueReceiptEmail`) and delivered by `syncReceiptEmails()` through `/api/pos/receipt-email`.
- The email route forwards to `POS_RECEIPT_EMAIL_WEBHOOK`; without it, it returns `501` and the receipt stays queued with a visible error.

### 4.9 Returns and refunds

**Files:** `components/pos/return-pin-dialog.tsx`, `components/pos/return-dialog.tsx`, `lib/returns.ts`, `supabase/migrations/017_pos_returns.sql`, `supabase/migrations/020_pos_returns_ledger.sql`

- A return requires a manager PIN before the return dialog opens.
- The manager PIN is checked locally against active users with role `manager`.
- The cashier can return against one of the last 20 sales, or scan a barcode for a no-receipt return.
- The local ledger is the source of truth for already-returned units; the dialog disables items that are fully returned.
- Return quantity is capped at the outstanding quantity on the original sale.
- Refund defaults to the price paid less the sale's basket discount; it can be overridden.
- Refund method can be cash, M-Pesa or card; non-cash refunds can carry a reference.
- `recordReturn()` writes the ledger row, increments stock, and queues the return in one Dexie transaction.
- The server RPC records the return, lines, refund and stock correction, and rejects over-returns.
- After a successful push, the queue row is deleted and the ledger row gets `syncedAt`.

### 4.10 Manager dashboard

**Files:** `components/manager/manager-dashboard.tsx`, `lib/sales.ts`, `lib/time.ts`

- Everything is read from IndexedDB, never from Supabase, so figures are identical online and offline and include unsynced sales.
- “Today” is an **East Africa Time (UTC+3)** day, not the device's local day.
- Shows total sales, bags sold, shoes sold, payment mix, average sale, catalogue size, last sync time and pending queue depth.
- Shows a sync issue banner, low-stock list (under 5 units), and the last 10 transactions with sync status.
- Provides “Sync now” and “Refresh catalogue” actions.
- Includes the cash-drawer panel.

### 4.11 Cash drawer

**Files:** `components/manager/cash-drawer.tsx`, `lib/till.ts`

- Open a shift with an opening float.
- Expected cash = opening float + cash sales − cash refunds.
- Close a shift against a physical count; variance is `counted − expected`.
- `expectedCash`, `countedCash` and `variance` are stamped at close and kept.
- Recent shifts show open status or a variance badge.
- Local-only: drawer sessions are not synced to Supabase.

### 4.12 Staff management

**Files:** `components/manager/staff-manager.tsx`, `lib/staff.ts`, `supabase/migrations/016_pos_staff_enrolment.sql`

- Managers can enrol a cashier with a name and a PIN.
- The PIN is bcrypt-hashed in the browser; only the hash is sent to Supabase.
- Enrolment requires a connection because the account must exist on the server.
- `createCashier()` refuses a PIN already used by an active local user.
- The local roster is refreshed after enrolment so the new cashier can sign in immediately.
- Deactivation, re-pinning and promotion are not implemented.

### 4.13 Inventory and product creation

**Files:** `components/manager/product-form.tsx`, `app/manager/inventory/page.tsx`, `lib/sync.ts`, `supabase/migrations/019_pos_product_creation.sql`

- Managers can create a product with name, category (bag/shoe), price, opening stock, optional barcode, optional QR/bag serial, colourways, optional image, and a website-publish flag.
- Images are resized to at most 1200px and stored as WebP/JPEG data URLs locally; they are not uploaded.
- Colourways are local-only; the POS does not write `product_colors`.
- The product row is written to Dexie and queued as a `product` sync entry.
- The product is pushed through `pos_create_product`, an insert-only SECURITY DEFINER RPC.
- The catalogue list below the form shows local products, stock, colours and publication state.

### 4.14 Stock adjustments

**Files:** `components/manager/stock-adjustment.tsx`, `lib/sync.ts`, `supabase/migrations/021_pos_settings_discounts_adjustments.sql`

- A manager selects a product, enters a positive or negative delta, and an optional reason.
- The local product stock is updated immediately (never below zero) and a `stock_adjustment` queue entry is written in one Dexie transaction.
- `syncStockAdjustments()` calls `pos_adjust_stock(p_product_id, p_delta)`.
- The server RPC updates `products.stock_quantity` with `GREATEST(0, stock + delta)`.
- The `reason` is not persisted server-side.

### 4.15 Manager settings and discounts

**Files:** `app/manager/settings/page.tsx`, `supabase/migrations/021_pos_settings_discounts_adjustments.sql`, `components/pos/cart-panel.tsx`

- Settings screen manages:
  - the shared `shop_settings.exchange_rate_kes_to_usd`;
  - discount codes in `pos_discounts`.
- Discount codes are cached locally in Dexie `pos_discounts`.
- The cart accepts a discount code by looking up the local table and applying its percentage.
- The cart also has a fixed 10% preset button.
- Settings is currently **not linked** from `ManagerNav`; only the overview, staff and inventory tabs exist.

### 4.16 Customer-facing VFD display

**Files:** `lib/customer-display.ts`, `hooks/use-customer-display.ts`, `components/pos/customer-display-control.tsx`, `components/pos/pos-screen.tsx`, `types/webserial-customer-display.d.ts`

- Uses `@point-of-sale/webserial-customer-display` over Web Serial.
- Implemented as a singleton external store (`useSyncExternalStore`) rather than React state.
- The header pill offers “Connect Display”; once connected it shows “Display Connected”.
- The device vendor/product id is persisted to `localStorage` for reconnect after reload.
- Paints only `TOTAL: KES <amount>`, updated from the cart total.
- Latest paint is kept while disconnected and flushed on connect.
- Web Serial requires a user gesture, so connection is button-driven.

### 4.17 Sync engine

**File:** `lib/sync.ts`

Queue entities: `sale`, `return`, `product`, `stock_adjustment`, `receipt_email`.

`runSync()` order in the current code:

1. `syncSales()` — skip sales whose product create is still queued; defer them.
2. `syncProducts()` — push queued products.
3. Retry deferred sales.
4. `syncReturns()` — push returns and stamp the local ledger.
5. `syncStockAdjustments()` — push stock corrections.
6. `fetchProducts()` — refresh the catalogue.
7. `fetchPosUsers()` — refresh the staff roster.
8. `syncReceiptEmails()` — deliver queued receipt emails.

Other sync behaviour:

- Re-entrancy guarded: a second `runSync()` while one is running returns zeroes.
- Failures are isolated per step.
- `lastError` is reserved for money-related failures; `lastNotice` is for catalogue, roster, receipt and other non-money notes.
- Queue entries record `status`, `attempts`, `lastError` and `updatedAt`.
- Auto-sync runs on mount, on `online`, and every 60 seconds while the tab is visible.
- `fetchProducts()` writes stock as `server stock − pending sales + pending returns` for this till.
- An empty catalogue response is treated as a likely RLS/configuration failure and does not wipe the local catalogue.

### 4.18 Toast notifications

**Files:** `components/ui/toast-provider.tsx`, `components/ui/toast.tsx`, `components/sync-provider.tsx`, `components/auth/pin-login.tsx`

- Global provider mounted in `app/layout.tsx`.
- Variants: `success`, `error`, `warning`, `info`.
- Auto-dismiss after 4 seconds by default; `Infinity` keeps a toast until dismissed.
- Animated with `framer-motion`; motion is skipped under `prefers-reduced-motion`.
- Used for login success/failure, offline mode, settings errors, stock adjustment confirmation, and other feedback.
- SyncProvider raises a persistent “Offline Mode / Database disconnected” warning when Supabase is not configured.

### 4.19 Theming, responsive layout and accessibility

**Files:** `app/globals.css`, `app/layout.tsx`, `components/ui/modal.tsx`

- Brand tokens are centralised as CSS variables: brown, gold, cream, charcoal, success and danger.
- Fonts: Cormorant Garamond for display/serif, Manrope for sans.
- The POS uses a fixed-height shell at `lg` and above, with a scrollable catalogue and a fixed cart column.
- Reactive components use semantic tokens (`bg-primary`, `text-muted`, `border-border`) rather than raw hex values.
- The modal implements `role="dialog"`, `aria-modal`, labelled title/description, Escape handling, focus trap, focus restoration, and body-scroll lock.
- Reduced-motion handling is present in the modal, toasts and cart animations.

### 4.20 API routes

| Route | Purpose | Notes |
| --- | --- | --- |
| `POST /api/pos/mpesa/stk-push` | Initiate Lipa Na M-Pesa STK Push | Server-side credentials; validates amount/phone |
| `POST /api/pos/mpesa/callback` | Receive Safaricom callback | Logs result; returns result code and confirmation code |
| `POST /api/pos/receipt-email` | Forward queued receipt email | Requires `POS_RECEIPT_EMAIL_WEBHOOK`; otherwise `501` |

---

## 5. Supabase data model

Migrations `001–011` are mirrored from the storefront. The POS owns `012–021`.

| Migration | Purpose |
| --- | --- |
| `012_pos.sql` | `pos_users`, `pos_sales`, `pos_sale_items`, RLS |
| `013_pos_stock.sql` | `pos_apply_sale_stock` idempotent stock decrement |
| `014_pos_record_sale.sql` | `pos_record_sale` — single atomic sale write path |
| `015_pos_card_payments.sql` | adds `card` as a payment method |
| `016_pos_staff_enrolment.sql` | allows anon to insert active cashier rows |
| `017_pos_returns.sql` | returns tables, website publishing flag, `pos_record_return` |
| `018_pos_rotate_demo_manager_pin.sql` | rotates the demo manager PIN |
| `019_pos_product_creation.sql` | `pos_create_product`, FK-safe returns, tighter anon boundary |
| `020_pos_returns_ledger.sql` | refunds and server-side over-return protection |
| `021_pos_settings_discounts_adjustments.sql` | exchange-rate column, `pos_discounts`, `pos_adjust_stock` |

Current anon capability surface:

- `SELECT products`, `product_colors`, `product_images`
- `SELECT pos_users` (including bcrypt hashes)
- `INSERT pos_users` for `role = 'cashier'`, `active = true`
- `CALL pos_record_sale(...)`
- `CALL pos_create_product(...)`
- `CALL pos_record_return(...)`
- `CALL pos_daily_totals(...)`
- `SELECT pos_discounts`
- `CALL pos_adjust_stock(...)`

It cannot read sales back, cannot read sale lines, and cannot write the catalogue directly.

---

## 6. Git status and repository state

### Branch

```text
feature-toasts-and-login-fix
```

- This branch has **no upstream configured**.
- It is **2 commits ahead of `origin/main`** and **0 commits behind**.
- The merge base is `0f88725 working here`, which is the current tip of `origin/main`.
- The branch can therefore be fast-forwarded into `origin/main` without a merge commit.

Commits on the branch but not on `origin/main`:

```text
191ce41 Add manager settings, stock adjustments, and discounts
d034b78 Add toast notification system and instrument login flow
```

### Working tree

```text
On branch feature-toasts-and-login-fix
nothing to commit, working tree clean
```

- No staged, modified or deleted tracked files at analysis time.
- No untracked tracked-area files at analysis time.
- No stashes.
- No tags.
- `report.md` is the new file created by this analysis and is untracked until committed.

### Ignored files present

These exist locally but are ignored by `.gitignore`:

| File | Why |
| --- | --- |
| `.env.local` | secrets/local configuration |
| `public/sw.js` | generated Serwist service worker |
| `tsconfig.tsbuildinfo` | TypeScript incremental build cache |
| `node_modules/` | dependencies |
| `.next/` | Next build output |

### Branches

Local branches:

```text
* feature-toasts-and-login-fix
  feature-vfd-and-qr
  main
  phase-0-money-safety
  phase-1-server-boundaries
  phase-2-feature-c
  phase-3-returns-ledger
  phase-4-mpesa-stk-push
```

Remote branches:

```text
origin/main
origin/feature-vfd-and-qr
origin/phase-0-money-safety
origin/phase-1-server-boundaries
origin/phase-2-feature-c
origin/phase-3-returns-ledger
```

Notable remote gaps:

- `feature-toasts-and-login-fix` has not been pushed.
- `phase-4-mpesa-stk-push` exists locally but not on the remote.

### Recent history

```text
191ce41 Add manager settings, stock adjustments, and discounts
d034b78 Add toast notification system and instrument login flow
0f88725 working here
ebcf83d Phase 6: Redesign login brand panel and fix favicon
2643bf2 Phase 5: Customer-facing VFD display + QR code scanning integration
8d9fcdf Phase 4: M-Pesa STK Push (Lipa Na M-Pesa) with manual fallback and error logging
4e06641 Sync products before returns so server stock can be restocked
11f4067 Record the signed-in cashier on no-receipt returns
589668a docs: record the Phase 3 migration rollout
9dfbb44 Phase 3: complete returns with a local ledger and refunds
```

---

## 7. Findings and risks

### High — M-Pesa callback parser does not match the standard Daraja payload

**Files:** `lib/mpesa.ts:384-397`, `app/api/pos/mpesa/callback/route.ts`

The parser expects:

```text
Body.CallbackMetadata.Item[] with Key = "MpesaConfirmationCode"
top-level ResultCode
```

Standard Safaricom Daraja callbacks arrive as:

```text
Body.stkCallback.ResultCode
Body.stkCallback.ResultDesc
Body.stkCallback.CallbackMetadata.Item[] with Name = "MpesaReceiptNumber"
```

As written, a real callback is likely to be read with `resultCode = 0` and `confirmationCode = null`. The route then logs an error and returns no confirmation code. The manual fallback in checkout hides this during testing.

### High — M-Pesa endpoints and token flow differ from documented Daraja

**File:** `lib/mpesa.ts:41-48, 129-147, 209-227`

The code uses `https://api.sandbox.m-pesa.com/mpesa/api/v1/token/` and `.../stkpush/processrequest`, and posts a JSON body to the token endpoint. Documented Safaricom Daraja uses:

```text
GET  https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials
POST https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest
```

If a custom gateway is not in front of `api.m-pesa.com`, STK Push will not reach Safaricom. This should be confirmed against the actual provider before production.

### High — Manager settings writes are blocked by RLS

**Files:** `app/manager/settings/page.tsx:54-56, 69-71`; `supabase/migrations/008_shop_settings.sql:32-34`; `supabase/migrations/021_pos_settings_discounts_adjustments.sql:16-18`

- `shop_settings` UPDATE is granted to `authenticated` only.
- `pos_discounts` writes are granted to `authenticated` only.
- The POS Supabase client uses the anon key with no Supabase auth session (`lib/supabase/client.ts` sets `persistSession: false`).
- Therefore “Save” on the exchange rate and “Add” on a discount will return an RLS error, and the UI will show a toast instead of saving.

The settings screen needs either a server route with appropriate credentials, an authenticated admin session, or it should be removed and the operation moved to the storefront admin.

### High / Medium — Stock-adjustment sync can silently lose work

**File:** `lib/sync.ts:734-761`

`syncStockAdjustments()` awaits `client.rpc("pos_adjust_stock", ...)` but never inspects the returned `{ error }`. Supabase RPC calls return errors in the result object rather than throwing, so an RLS or database failure is treated as success and the queue entry is deleted.

Additionally:

- `pendingStockByProduct()` (`lib/sync.ts:291-337`) only accounts for unsynced sales and returns, not pending stock adjustments.
- If a stock adjustment fails and `fetchProducts()` still runs, the catalogue refresh can overwrite the local adjusted stock with the server's old figure.

### Medium — Auth is a convenience boundary, not a security boundary

**Files:** `lib/auth.ts`, `components/require-auth.tsx`, `supabase/migrations/012_pos.sql:190-195`

- The session is editable `localStorage`.
- `anon` can read `pos_users.pin_hash`; a 4-digit PIN has only 10,000 possibilities.
- A user with DevTools can promote themselves to manager.
- This is documented as a Phase 1 tradeoff. The long-term fix is device-token enrolment plus server-side PIN verification with a short-lived offline assertion.

### Medium — Anyone with the anon key can enrol a cashier

**File:** `supabase/migrations/016_pos_staff_enrolment.sql`

The insert policy only checks `role = 'cashier'` and `active = true`. There is no server session proving the caller is a manager. A cashier who edits `localStorage` can reach `/manager/staff` and create accounts.

### Medium — Receipt email endpoint has no authentication or rate limiting

**File:** `app/api/pos/receipt-email/route.ts`

Any caller can POST a `clientUuid` and email address, and the route forwards it to the configured webhook. It validates shape only, not origin, identity or rate. Also, it forwards only `{ clientUuid, email }`; the webhook would need to fetch the sale elsewhere to render the receipt, and sales are not readable by anon.

### Medium — M-Pesa callback endpoint has no signature verification

**File:** `app/api/pos/mpesa/callback/route.ts`

The endpoint accepts any JSON body. Today it only logs and echoes the result, so the immediate impact is limited, but once the callback is used to mark a sale paid, this becomes a money-path issue.

### Medium — Settings screen is missing from manager navigation

**Files:** `components/manager/manager-nav.tsx:21-23`, `app/manager/settings/page.tsx`

`ManagerNav` only links Overview, Staff and Inventory. `/manager/settings` can be reached only by typing the URL.

### Medium — Inventory page composes two inconsistent layouts

**Files:** `app/manager/inventory/page.tsx:13-14`, `components/manager/product-form.tsx`, `components/manager/stock-adjustment.tsx:44`

`ProductForm` renders its own `AppHeader`, `SyncProvider`, `ManagerNav` and `<main>`. `StockAdjustment` renders a bare `<div className="p-8">` with its own `<h1>`. `InventoryPage` places both in a wrapper, so the stock-adjustment section appears outside the main layout and duplicates the heading/chrome pattern. The settings page has the same issue: it renders only a bare `<div>` with no app header or manager navigation.

### Medium — PIN length contract is inconsistent

**Files:** `lib/auth.ts:39-40`, `lib/staff.ts:31-32`

- Constants: minimum 4, maximum 4.
- Validator: 4 only.
- Error message: “The PIN must be 4 to 6 digits.”
- Staff form input: `maxLength` 4.

The user-facing message disagrees with the actual rule.

### Medium — Discounts are not part of normal sync

**Files:** `app/manager/settings/page.tsx:32-43`, `components/pos/cart-panel.tsx:154`

`pos_discounts` is only fetched and cached when the settings page mounts. A till that never opens settings will not have the latest discount codes, and there is no `syncDiscounts()` step in `runSync()`.

### Medium — Stock adjustment reason is discarded server-side

**File:** `supabase/migrations/021_pos_settings_discounts_adjustments.sql`

`pos_adjust_stock(p_product_id, p_delta, p_reason)` accepts a reason but ignores it, and there is no audit table. The local queue payload carries `reason`, but the server does not record it.

### Low — Documentation drift

**Files:** `README.md`, `PROJECT_GUIDE.md`, `lib/sync.ts` header comment

- `PROJECT_GUIDE.md` still describes Dexie schema version 2 (actual: 5).
- It still lists a hard-coded `9999` manager bypass (removed; `018` rotates the demo PIN).
- It says POS migrations are `012–016` (actual: `012–021`).
- It does not cover the manager settings, stock adjustments, discounts or toast features.
- `lib/sync.ts` and parts of the README omit `syncStockAdjustments` from the documented sync order.

### Low — Diagnostic console log left in login flow

**File:** `components/auth/pin-login.tsx:99`

```ts
console.log("Staff roster length after fetch:", data.length);
```

Harmless, but it is diagnostic output in a production till UI.

### Low — Settings screen reads `navigator` in a state initializer

**File:** `app/manager/settings/page.tsx:15`

```ts
const [offline] = useState(() => !navigator.onLine || !isSupabaseConfigured());
```

This is evaluated during rendering and is not reactive. If connectivity changes after load, the screen stays in its initial offline/online state until reload. It also risks differing between server render and client hydration depending on the Node/browser `navigator` implementation.

### Low — Toast accessibility and persistence

**Files:** `components/ui/toast.tsx`, `components/ui/toast-provider.tsx`, `components/sync-provider.tsx`

- The toast container has no `aria-live` region, so screen readers may not announce messages.
- Toasts have no close button.
- The “Offline Mode” toast is raised with `duration: Infinity`, so it cannot be dismissed from the UI.

### Low — No unit test suite

The only test script is `test:rls`, which runs the pgTAP RLS boundary test against a local Supabase. There are no unit tests for the pure logic that is easiest to test: `lib/cart.ts`, `lib/sales.ts` arithmetic, `lib/time.ts`, and the sync ordering.

### Low — Unused starter/diagnostic assets

The project still contains unused starter assets and a small number of diagnostic leftovers. The main functional one is the login `console.log` above.

---

## 8. Strengths

- **The sale path is genuinely local-first and crash-safe.** The sale, stock decrement and queue entry share one Dexie transaction.
- **Idempotency is designed correctly.** Client UUIDs are used as both primary and idempotency keys, and the server RPCs are insert-only or guarded.
- **Stock reconciliation is thoughtful.** Unsynced sales and returns are derived from the local ledger rather than stored separately, which prevents drift.
- **The server boundary is narrow.** The anon key cannot read sales or write the catalogue directly; RPCs are the write path.
- **Offline navigation is correct.** Plain anchors and `window.location` avoid the RSC payload dependency that would break offline navigation.
- **Accessibility is above average for a POS.** The modal has focus trapping, focus restoration, labels and reduced-motion handling.
- **Documentation and code comments explain *why*, not just *what*.** This is rare and valuable.
- **Build, lint and typecheck all pass.**

---

## 9. Recommended next steps

1. **Fix or document the M-Pesa integration.**
   - Align endpoints and auth with the actual provider (Daraja or gateway).
   - Parse `Body.stkCallback.*` and `MpesaReceiptNumber`.
   - Add callback-to-sale association and a completion path so the till does not require manual code entry after a successful prompt.
   - Verify the callback with the provider's signature/IP allow-list if available.

2. **Fix manager settings writes.**
   - Move exchange-rate and discount writes behind a server route with appropriate credentials, or
   - Require an authenticated admin session for these operations, or
   - Remove the write UI from the POS and keep the storefront admin as the source of truth.

3. **Fix stock-adjustment sync.**
   - Check the `{ error }` returned by `client.rpc("pos_adjust_stock", ...)`.
   - Include pending stock adjustments in `pendingStockByProduct()` so a failed push cannot be overwritten by `fetchProducts()`.
   - Persist `reason` server-side or remove it from the UI.

4. **Sync discount codes automatically.**
   - Add a `syncDiscounts()` / `fetchDiscounts()` step to `runSync()` and cache `pos_discounts` on every successful sync.

5. **Unify manager layouts and navigation.**
   - Add a Settings tab to `ManagerNav`.
   - Make `StockAdjustment` and the settings page use the same `AppHeader` / `ManagerNav` / `SyncProvider` shell as the dashboard and staff screens.
   - Avoid nesting components that each render their own `<main>`.

6. **Resolve the PIN contract.**
   - Decide 4 digits or 4–6 digits.
   - Make `PIN_MIN_LENGTH`, `PIN_MAX_LENGTH`, `isValidPinFormat`, the staff error message and the input `maxLength` agree.

7. **Harden auth for production.**
   - Treat the current PIN/localStorage model as a Phase 1 boundary.
   - Move to device-token enrolment and server-side PIN verification with a short-lived offline assertion.
   - Stop exposing bcrypt hashes to the anon key.

8. **Add automated tests.**
   - Unit-test `lib/cart.ts`, `lib/sales.ts`, `lib/time.ts` and the sync ordering.
   - Keep the existing pgTAP RLS test.

9. **Refresh documentation.**
   - Update `PROJECT_GUIDE.md` for Dexie v5, migrations `012–021`, removal of `9999`, settings, stock adjustments, discounts and toasts.
   - Document the actual sync order including `syncStockAdjustments`.

10. **Polish notifications and settings.**
    - Add `aria-live` to the toast container.
    - Add a dismiss control for persistent toasts.
    - Make the settings offline state reactive (listen to `online`/`offline`).

---

## 10. File ownership quick reference

| Concern | File |
| --- | --- |
| App shell / metadata | `app/layout.tsx` |
| POS screen | `components/pos/pos-screen.tsx` |
| Cart UI | `components/pos/cart-panel.tsx` |
| Cart logic | `lib/cart.ts` |
| Checkout / payment UI | `components/pos/checkout-dialog.tsx` |
| Sale recording | `lib/sales.ts` |
| Returns | `lib/returns.ts`, `components/pos/return-dialog.tsx` |
| Cash drawer | `lib/till.ts`, `components/manager/cash-drawer.tsx` |
| Manager dashboard | `components/manager/manager-dashboard.tsx` |
| Staff management | `lib/staff.ts`, `components/manager/staff-manager.tsx` |
| Product creation | `components/manager/product-form.tsx` |
| Stock adjustments | `components/manager/stock-adjustment.tsx`, `lib/sync.ts` |
| Settings / discounts | `app/manager/settings/page.tsx` |
| Local schema | `lib/db.ts` |
| Sync engine | `lib/sync.ts` |
| Auth / PIN | `lib/auth.ts`, `components/auth/pin-login.tsx` |
| Route guard | `components/require-auth.tsx` |
| Supabase client | `lib/supabase/client.ts` |
| M-Pesa server client | `lib/mpesa.ts` |
| M-Pesa routes | `app/api/pos/mpesa/*` |
| Receipt email route | `app/api/pos/receipt-email/route.ts` |
| Receipt layout | `components/pos/receipt.tsx` |
| Customer display | `lib/customer-display.ts`, `hooks/use-customer-display.ts` |
| PWA manifest | `app/manifest.ts` |
| Service worker | `app/sw.ts` |
| Toasts | `components/ui/toast-provider.tsx`, `components/ui/toast.tsx` |
| Theme tokens / print CSS | `app/globals.css` |

---

*End of report.*
