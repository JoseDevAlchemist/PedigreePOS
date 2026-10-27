# Pedigree POS — Project Guide

> A route-by-route analysis of the Pedigree Leather point-of-sale PWA, plus the
> architecture, data model, and risks behind each screen.
>
> Scope: the code in this repository as of the analysis date. `README.md` is the
> original project narrative; this guide is the map of how the pieces actually
> fit together.

---

## 1. What this app is

Pedigree POS is a **desktop-first, offline-first point of sale** for the Pedigree
Leather workshop in Nairobi. It shares its Supabase project with the storefront,
so a bag sold over the counter also comes off the website's stock.

The central rule: **the shop must keep selling when the network drops.** Sales
are written to the device first (IndexedDB), then pushed to Supabase in the
background whenever a connection exists.

| Layer | Technology |
| --- | --- |
| Framework | Next.js 16.4 (App Router, React 19) |
| Styling | Tailwind CSS v4 via PostCSS |
| Local database | Dexie / IndexedDB |
| Remote database | Supabase (Postgres, RLS, RPC functions) |
| Auth | Device-local PIN check against bcrypt hashes |
| PWA / offline | Serwist service worker (`app/sw.ts` → `public/sw.js`) |
| Motion | Framer Motion |
| Icons | Lucide React |

### Quick start

```bash
pnpm install
cp .env.example .env.local   # fill in the two Supabase values
pnpm dev                     # http://localhost:3000
```

Demo staff, if `supabase/pos_seed.sql` has been applied:

| Name | Role | PIN |
| --- | --- | --- |
| Brian Otieno | cashier | `1234` |
| Grace Wanjiru | manager | `9999` |

> These are throwaway demo credentials. Change them before the till handles real
> money. Also read the security findings in §10 — the current login code has a
> temporary `9999` bypass in it.

### Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Development server, webpack |
| `pnpm build` | Production build, webpack |
| `pnpm start` | Serve the production build |
| `pnpm lint` | ESLint, including `react-hooks` |

The `--webpack` flag is required: `@serwist/next` is a webpack plugin, and
Next 16 defaults to Turbopack. A Turbopack build silently produces no service
worker. After `pnpm build`, confirm `public/sw.js` exists.

---

## 2. Route map at a glance

Every user-facing route lives under `app/`. There is exactly **one API route**.

| Route | Source file | Type | Who can reach it | What it does | Leads to |
| --- | --- | --- | --- | --- | --- |
| `/` | `app/page.tsx` | Server page | Anyone | Entry point only; no UI | Server-side redirect to `/pos` |
| `/login` | `app/login/page.tsx` | Server page + client components | Anyone | PIN sign-in screen and first-run roster sync | `/pos` after success (hard navigation) |
| `/pos` | `app/pos/page.tsx` | Server page + client screen | Any signed-in user | The till: catalogue, cart, checkout, receipt | `/login` if unauthenticated; `/manager` via header if manager |
| `/manager` | `app/manager/page.tsx` | Server page + client screen | Managers only | Daily figures, low stock, recent sales, cash drawer | `/login` if unauthenticated; `/pos` if wrong role; `/manager/staff` via sub-nav |
| `/manager/staff` | `app/manager/staff/page.tsx` | Server page + client screen | Managers only | List cashiers and enrol a new one | Same guard redirects as `/manager` |
| `/~offline` | `app/~offline/page.tsx` | Static fallback page | Anyone | Shown by the service worker when an offline document request misses cache | Reloads itself via **Try again** |
| `/api/pos/receipt-email` | `app/api/pos/receipt-email/route.ts` | Route handler (`POST`) | Anyone who can reach the server | Forwards a queued receipt email to the configured webhook | Upstream webhook; JSON response to the till |
| `/manifest.webmanifest` | `app/manifest.ts` | Metadata route | Browser | PWA manifest; `start_url` is `/pos` | Installed app opens `/pos` |
| `/sw.js` | `public/sw.js` (built from `app/sw.ts`) | Static asset | Browser | Service worker: precache, runtime cache, offline fallback | Serves cached routes; `/~offline` on failure |
| `/pedigree-logo.png`, `/icons/*` | `public/` | Static assets | Anyone | Branding, PWA icons, Apple touch icon | — |
| `/_not-found` | Next.js default | Framework page | Anyone | Default 404; no custom `not-found.tsx` in this repo | — |

### Route flow

```text
                              ┌──────────────────────┐
                              │  /  (server redirect)│
                              └──────────┬───────────┘
                                         │ redirect("/pos")
                                         ▼
                              ┌──────────────────────┐
        no session ──────────►│        /pos          │
        RequireAuth           │  till (client)       │
        window.location       └──────┬───────┬───────┘
              │                     │       │ manager header link
              ▼                     │       ▼
      ┌──────────────┐              │  ┌──────────────────┐
      │    /login    │              │  │    /manager      │
      │  PIN keypad  │              │  │  dashboard       │
      └──────┬───────┘              │  └────┬─────────────┘
             │ success              │       │ sub-nav
             │ window.location      │       ▼
             └──────────────────────┘  ┌──────────────────┐
                                       │ /manager/staff   │
                                       └──────────────────┘

  Wrong role on /manager or /manager/staff ──► /pos
  Sign out from any header ──────────────────► /login
  Offline document request with no cache ────► /~offline
  Queued receipt email ──► POST /api/pos/receipt-email ──► POS_RECEIPT_EMAIL_WEBHOOK
```

---

## 3. Route-by-route analysis

### `/` — entry point

**File:** `app/page.tsx`

```tsx
export default function Home() {
  redirect("/pos");
}
```

- Pure server component. It renders nothing.
- `redirect()` sends the browser to `/pos`; `/pos` then decides whether the user
  is signed in.
- This is a server-side redirect, so a cold visit never flashes a landing page.

**Leads to:** `/pos`.

---

### `/login` — PIN sign-in

**File:** `app/login/page.tsx` (server component)
**Client pieces:** `components/auth/pin-login.tsx`, `components/supabase-connection-check.tsx`, `components/sync-provider.tsx`

**Layout**

Two panels at desktop width:

- Left: dark brand panel with the Pedigree lockup and a short statement about
  offline selling. Decorative; hidden below `lg`.
- Right: the keypad, rendered by `<PinLogin />`.

**What it does**

1. Mounts `<SyncProvider />`, which starts automatic syncing.
2. Mounts `<SupabaseConnectionCheck />`, a temporary diagnostic that logs whether
   the anon client can read `products`.
3. `PinLogin` runs `fetchPosUsers()` on mount to pull the staff roster (including
   bcrypt hashes) into IndexedDB. A network failure is logged and ignored.
4. Reads active users from the local `pos_users` table.
   - No users → renders **“No staff on this device yet”** with a **Try again**
     button.
   - Users found → renders the PIN dots, keypad, and hidden input.
5. A PIN is 4 digits. When the fourth digit is entered, submission starts
   automatically.
6. The PIN is checked against every active user's bcrypt hash
   (`verifyPin` in `lib/auth.ts`). First match wins.
7. On success: creates a session, writes it to `localStorage`, and performs a
   **hard navigation** to `/pos` with `window.location.replace`.
8. On failure: clears the PIN, shows the remaining attempts, and locks the keypad
   for 30 seconds after 5 failures.

**Already signed in?** An effect redirects authenticated users to `/pos`.

**Important implementation details**

- The visible keypad is decorative; the real control is a hidden
  `<input type="password">` so a physical keyboard and password managers work.
- A USB barcode scanner is irrelevant here because the PIN input is focused.
- The roster must have reached the device once. After that, sign-in works
  offline.
- The “Try again” button re-runs the roster effect by incrementing a token; it
  does not reload the page.

**Leads to:** `/pos` on success; remains on `/login` on failure or empty roster.

**Temporary code to remove:** `components/auth/pin-login.tsx` contains a
hard-coded `9999` branch that signs in a fabricated manager without checking the
database. `lib/auth.ts` also treats `9999` as valid for every user. See §10.

---

### `/pos` — the till

**File:** `app/pos/page.tsx` (server wrapper with metadata)
**Client screen:** `components/pos/pos-screen.tsx`
**Guard:** `components/require-auth.tsx` with no role restriction

**Access**

`<RequireAuth>` wraps the screen:

- `localStorage` is read through `useAuth`.
- While auth is resolving, a branded splash (“Signing you in…”) is shown. This
  prevents a signed-in cashier from being bounced on reload.
- No session → `window.location.replace("/login")`.
- Any signed-in role is allowed (cashier or manager).

**What the screen contains**

| Region | Component | Purpose |
| --- | --- | --- |
| Header | `components/app-header.tsx` | Brand, Till/Manager nav, clock, network status, user, sign out |
| Search + categories | inline in `pos-screen.tsx` | Filter catalogue by name, slug, barcode, category |
| Catalogue grid | `components/pos/product-grid.tsx` | Product cards with image, price, discount, stock |
| Cart | `components/pos/cart-panel.tsx` | Quantities, remove, clear, 10% discount, totals, Charge |
| Checkout | `components/pos/checkout-dialog.tsx` | Cash / M-Pesa / Card; change or reference |
| Receipt | `components/pos/receipt-dialog.tsx` + `receipt.tsx` | 80mm receipt, print, email queue |

**What it does**

1. On mount, `runSync()` runs once. Failures are logged; the screen does not
   block.
2. `useProducts()` reads the local catalogue live from Dexie, so a sync that
   lands mid-shift updates the grid automatically.
3. Search filters by name, slug, barcode, and category. Category chips are
   derived from the catalogue.
4. Barcode handling has two paths:
   - No editable field focused → the global `useBarcodeScanner` hook collects
     fast keystrokes and acts on Enter.
   - Search box focused → scanner input lands in the box; Enter resolves an exact
     barcode/slug match and adds it.
   - A scan only resolves exact barcode or slug matches. Unknown codes flash a
     warning.
5. Adding a product dispatches to the pure cart reducer
   (`lib/cart.ts`). The same product is one line with an incremented quantity,
   capped by local stock.
6. **Charge** opens the checkout dialog:
   - **Cash:** amount tendered, quick-tender notes, live change/short display.
   - **M-Pesa:** confirmation code (minimum 4 characters).
   - **Card:** terminal slip reference (minimum 4 characters).
   - Neither M-Pesa nor Card calls a payment provider; the till records what the
     cashier read off the machine.
7. Confirming calls `completeSale()` (`lib/sales.ts`), which writes in **one
   Dexie transaction**:
   - the sale and its embedded lines to `pos_sales`,
   - the stock decrement on each `products` row,
   - a `sale` entry in `sync_queue`.
8. The cart is cleared **before** the receipt dialog opens, so a distracted
   cashier cannot charge the same basket twice.
9. The receipt dialog offers:
   - **Print receipt** → `window.print()` with the 80mm print rules,
   - **Email a copy** → queues a `receipt_email` job,
   - **Start next sale** → closes the dialog.

**Offline behavior:** all of the above works without a connection. Nothing in
`completeSale` awaits the network. The only network-dependent feature on the
screen is a catalogue refresh, and an empty catalogue produces a clear empty
state.

**Leads to:** `/login` (guard), `/manager` (header, managers only), `/~offline`
(offline document miss).

---

### `/manager` — manager overview

**File:** `app/manager/page.tsx`
**Layout / guard:** `app/manager/layout.tsx` → `<RequireAuth role="manager">`
**Client screen:** `components/manager/manager-dashboard.tsx`

**Access**

- No session → `/login`.
- Signed in as cashier → `window.location.replace("/pos")`.
- Signed in as manager → allowed.

The guard is in the layout, so every future `/manager/*` route inherits it
automatically.

**What it does**

Everything on the page is read from the **local database**, not Supabase. That
is deliberate: the dashboard must show the same numbers online and offline, and
the local DB is the only place that holds sales the server has not seen yet.

| Section | Data source | What it shows |
| --- | --- | --- |
| Header | `useAuth`, `useSyncState` | Current date, “sync now”, “refresh catalogue” |
| Manager nav | `manager-nav.tsx` | Overview / Staff |
| Sync issue banner | `useSyncState` | First money error, then non-money notice |
| Stat cards | `getDailyTotals()` | Total sales, sale count, average, bags, shoes, payment mix |
| Till status | `useSyncState`, product count | Catalogue size, last sync, pending count, network pill |
| Cash drawer | `components/manager/cash-drawer.tsx` | Open/close shift, float, expected cash, variance, recent shifts |
| Low stock | `products` where `stockQuantity < 5` | Worst first, up to 8 products |
| Recent transactions | `getRecentSales(10)` | Last 10 sales with cashier, payment, total, sync status |

**Time semantics:** “today” is an **East Africa Time (UTC+3)** day, using
`lib/time.ts`, not the device's local day. A till left on UTC therefore files an
11pm sale under the correct Nairobi date.

**Sync status:** unsynced sales are labelled **Saved locally**; synced sales are
labelled **Synced**. The dashboard does not pretend local data is final.

**Actions**

- **Sync now** → `runSync()`.
- **Refresh catalogue** → `fetchProducts()` only.
- **Open till** → writes a `till_sessions` row with the opening float.
- **Close till** → calculates expected cash (float + cash sales since opening),
  records the counted amount, and stamps the variance.

**Leads to:** `/pos` (header), `/manager/staff` (sub-nav), `/login` on sign-out
or missing session.

---

### `/manager/staff` — staff management

**File:** `app/manager/staff/page.tsx`
**Guard:** inherited from `app/manager/layout.tsx`
**Client screen:** `components/manager/staff-manager.tsx`

**What it does**

1. Reads active cashiers from the local `pos_users` table, sorted by name, with a
   live query.
2. Shows each cashier with initials, name, role, and an **Active** badge.
3. Provides an **Add a cashier** form:
   - full name (minimum 2 characters),
   - 4-digit PIN,
   - hashes the PIN in the browser with bcrypt (cost 10),
   - refuses a PIN already used by an active user on this device,
   - inserts only the hash into Supabase `pos_users` with `role = 'cashier'`,
   - refreshes the local roster so the new cashier can sign in immediately.
4. Enrolment is the **one write in the POS that requires a connection**. A
   pending “create user” queue makes no sense: the account must exist on the
   server before any till can use it.

**Deliberately absent:** deactivating, re-pinning, promoting, or deleting staff.
The anon key has no `UPDATE`/`DELETE` policy on `pos_users`, so a half-built
editor would fail silently.

**Leads to:** `/manager` (sub-nav), `/pos` (header), `/login` on sign-out.

---

### `/~offline` — offline fallback

**File:** `app/~offline/page.tsx`
**Component:** `components/offline-shell.tsx`

- Static, self-contained page. It must not depend on the network, because the
  network is what is missing when it is shown.
- Precached by Serwist via `additionalPrecacheEntries` in `next.config.ts`.
- Registered as the fallback for any request whose `destination` is `document`
  (`app/sw.ts`).
- Offers **Try again**, which reloads the page.

**Leads to:** whatever the reload resolves to; remains on the shell if still
offline and uncached.

---

### `/api/pos/receipt-email` — receipt email proxy

**File:** `app/api/pos/receipt-email/route.ts`
**Method:** `POST`

The till never talks to an email provider directly. Sending a provider key to
every browser would leak it. Instead the browser posts to this server route,
which forwards to `POS_RECEIPT_EMAIL_WEBHOOK`.

**Request body**

```json
{
  "clientUuid": "uuid-of-the-sale",
  "email": "customer@example.com"
}
```

**Responses**

| Status | When | Body |
| --- | --- | --- |
| `202` | Webhook accepted the POST | `{ "ok": true }` |
| `400` | Invalid JSON, missing `clientUuid`, or malformed email | `{ "error": "..." }` |
| `501` | `POS_RECEIPT_EMAIL_WEBHOOK` is not set | `{ "error": "..." }` |
| `502` | Webhook returned non-2xx or was unreachable | `{ "error": "..." }` |

**Caller:** `syncReceiptEmails()` in `lib/sync.ts`, which drains `sync_queue`
entries with `entity = "receipt_email"`.

**Design notes**

- The receipt itself is rendered on the device at sale time. This endpoint only
  receives the sale id and email address.
- Validation is deliberately permissive; the provider is the real validator.
- The endpoint has **no authentication**. Anyone who can reach the deployment can
  POST to it and trigger the configured webhook. See §10.
- Without the env var, receipts stay queued and visibly unsent rather than being
  silently dropped.

---

### `/manifest.webmanifest` and the service worker

**Manifest:** `app/manifest.ts`

- `name` / `short_name`: Pedigree POS
- `id` and `start_url`: `/pos`
- `scope`: `/`
- `display`: `standalone`
- Icons: 192, 512, and maskable 512
- Theme: brown `#5d4037`, background cream `#f5e9d9`

**Service worker:** `app/sw.ts`, compiled to `public/sw.js` by Serwist.

- Precaches the app shell.
- `skipWaiting` + `clientsClaim` so a new build takes over promptly.
- `navigationPreload` enabled.
- `cacheOnNavigation` for instant back/forward.
- Document requests that miss the cache offline fall back to `/~offline`.
- The build revision is derived from `git rev-parse HEAD`, so an offline till
  does not keep serving yesterday's shell after a deploy.

---

### Static assets and 404

- `public/pedigree-logo.png` — brand lockup used by `BrandMark`.
- `public/icons/*` — PWA and Apple touch icons.
- `public/file.svg`, `globe.svg`, `next.svg`, `vercel.svg`, `window.svg` — Next.js
  starter assets; unused by the POS UI.
- There is no custom `not-found.tsx`. Unknown URLs get Next.js's default 404.

---

## 4. Project structure

```text
app/
  layout.tsx                 root fonts, metadata, AuthProvider
  page.tsx                   "/" -> "/pos"
  globals.css                brand tokens, 80mm print rules
  manifest.ts                PWA manifest
  sw.ts                      Serwist service worker source
  login/page.tsx             sign-in screen
  pos/page.tsx               till screen
  manager/
    layout.tsx               manager-only guard for the whole subtree
    page.tsx                 overview dashboard
    staff/page.tsx           staff management
  ~offline/page.tsx          offline fallback
  api/pos/receipt-email/
    route.ts                 the only server API

components/
  auth/pin-login.tsx         PIN keypad and roster-backed verification
  auth-provider.tsx          React view of the localStorage session
  require-auth.tsx           client-side, offline-proof route guard
  app-header.tsx             chrome, navigation, clock, sign out
  network-status.tsx         connection/sync pill
  brand-mark.tsx             logo lockup
  offline-shell.tsx          offline fallback body
  sync-provider.tsx          starts automatic sync
  supabase-connection-check.tsx  temporary diagnostic
  pos/
    pos-screen.tsx           till orchestration
    product-grid.tsx         catalogue cards
    cart-panel.tsx           basket and totals
    checkout-dialog.tsx      payment method and money entry
    receipt-dialog.tsx       post-sale actions
    receipt.tsx              80mm printable receipt
  manager/
    manager-dashboard.tsx    overview
    manager-nav.tsx          Overview / Staff tabs
    cash-drawer.tsx          shift open/close and variance
    staff-manager.tsx        cashier list and enrolment
  ui/modal.tsx               accessible portal dialog

hooks/
  use-auth.ts                auth context contract
  use-products.ts            live local catalogue
  use-barcode-scanner.ts     global scanner capture
  use-sync-state.ts          sync store subscription
  use-is-client.ts           hydration-safe client check

lib/
  auth.ts                    roles, sessions, bcrypt PIN hashing
  cart.ts                    pure cart reducer
  db.ts                      Dexie schema and types
  format.ts                  money, date, pluralisation
  sales.ts                   sale recording, daily totals, recent sales
  staff.ts                   cashier enrolment
  sync.ts                    push/pull engine and sync store
  till.ts                    cash drawer shifts
  time.ts                    East Africa Time helpers
  cn.ts                      class-name helper
  supabase/client.ts         anon Supabase client
  supabase/types.ts          hand-written database subset

supabase/
  migrations/                001–011 storefront mirrors
                             012 POS staff/sales/sale lines + RLS
                             013 idempotent stock application
                             014 pos_record_sale (the only write path)
                             015 card payment method
                             016 cashier enrolment policy
  pos_seed.sql               demo staff (optional)
  config.toml                Supabase CLI config
```

---

## 5. Architecture and data flow

### 5.1 Local-first

```text
 cashier action
      │
      ▼
 IndexedDB (Dexie)  ──► UI updates immediately
      │
      │  sync_queue entry
      ▼
 runSync()  ──► Supabase (best effort, idempotent)
      │
      └──► /api/pos/receipt-email ──► POS_RECEIPT_EMAIL_WEBHOOK
```

Supabase is treated as a **mirror**, not the source of truth for the current
shift. The local database is what the cashier and manager read.

### 5.2 Dexie tables

Defined in `lib/db.ts`, database name `pedigree-pos`, schema version 2.

| Table | Key | Holds | Notes |
| --- | --- | --- | --- |
| `products` | `id` | Catalogue, local stock, first image URL | Stock already reduced by every sale, synced or not |
| `pos_sales` | `clientUuid` | Sales with embedded line items | The idempotency key for sync |
| `pos_users` | `id` | Staff roster including bcrypt `pinHash` | Required for offline sign-in |
| `sync_queue` | `++id` | Work owed to the server | `sale` and `receipt_email` entities |
| `till_sessions` | `++id` | Cash-drawer shifts | Local-only, added in schema v2 |

Sale lines are embedded in the sale on the device. On the server they are
normalised into `pos_sale_items` because reporting wants to query them; locally
nothing queries a line independently, and embedding lets a sale and its lines be
written atomically.

### 5.3 Supabase surface available to the anon key

| Capability | Table / function | Why |
| --- | --- | --- |
| `SELECT` | `products` | Catalogue and stock |
| `SELECT` | `product_colors`, `product_images` | Product photography |
| `SELECT` | `pos_users` | bcrypt hashes for offline PIN checks (documented tradeoff) |
| `INSERT` | `pos_users` (cashier, active only) | Staff enrolment from the manager screen |
| `CALL` | `pos_record_sale(...)` | Record a sale, lines, and stock decrement atomically |
| `CALL` | `pos_daily_totals(...)` | Aggregate rollup; **not currently called by the UI** |

It cannot read a sale back, cannot read sale lines, and cannot write the
catalogue.

### 5.4 Sale write path

`completeSale()` in `lib/sales.ts`:

1. Rejects an empty basket.
2. Calculates totals with `calculateTotals()`.
3. Builds a `LocalSale` with a fresh `clientUuid` and a uuid per line.
4. Runs one Dexie transaction:
   - `pos_sales.add(sale)`
   - decrement each product's `stockQuantity`, never below zero
   - `sync_queue.add({ entity: "sale", entityId: clientUuid, status: "pending" })`
5. Calls `countPending()` so the header count updates before the network is
   touched.
6. Returns the sale; the receipt dialog opens.

The network is never awaited. If the app crashes after this, the sale is already
on disk.

### 5.5 Sync pipeline

Implemented in `lib/sync.ts`. `runSync()` runs one full pass and is re-entrancy
guarded: if a sync is already running, it returns zeroes.

**Actual order in code:**

1. `syncSales()` — each queued sale through `pos_record_sale`.
2. `fetchProducts()` — catalogue, with `server − unsynced_units` stock.
3. `fetchPosUsers()` — staff roster.
4. `syncReceiptEmails()` — queued receipt emails.

> **Documentation drift:** `README.md` and a header comment in `lib/sync.ts`
> describe the order as sales → receipts → products → users. The code does
> sales → products → users → emails. The important invariant — money before
> catalogue — is preserved, but the written order is wrong.

**Failure handling**

- Each step is isolated; a catalogue timeout does not stop sales from pushing.
- Sale failures set `lastError` (red).
- Catalogue, roster, and receipt failures set `lastNotice` (amber).
- Queue entries record `status: "error"`, `attempts`, and `lastError`.
- `pending` counts every queue entry, sales and receipts alike.

**Triggers**

`startAutoSync()` runs on mount, on the browser `online` event, and every 60
seconds while the tab is visible. It is mounted through `<SyncProvider />` on the
login, POS, manager, and staff screens.

### 5.6 Stock correctness

`fetchProducts()` writes stock as:

```text
server stock − units sold on this till but not yet synced
```

The deduction is derived from unsynced sales in `pos_sales`, not stored
separately, so it cannot drift. Without it, a refresh would overwrite a local
decrement and silently “un-sell” goods already handed over the counter.

### 5.7 Auth and route guarding

- Session storage key: `pedigree-pos.session` in `localStorage`.
- Session shape: `{ id, name, role, loggedInAt }`.
- `role` is `"cashier"` or `"manager"`.
- `AuthProvider` reads the session through `useSyncExternalStore`; the store is
  the storage itself, so cross-tab sign-out works via the `storage` event.
- `RequireAuth` is a client component on purpose. Middleware would run on the
  server and fail exactly when the till is offline.
- Redirects use `window.location.replace`, not the Next router. A document
  request for a precached route is served by the service worker; client-side
  navigation would need an RSC payload from the server.
- The role check is a **convenience boundary**, not a security boundary. Anyone
  with DevTools can edit `localStorage`. Real enforcement is RLS on the server.

### 5.8 Printing

- Receipt is `#receipt-print-area`, 80mm wide, black on white.
- Dialog is portalled to `document.body`, so `globals.css` can hide everything
  else with `body > *:not(.print-root)`.
- `@page { size: 80mm 297mm; margin: 0 }` selects roll paper. The height is a
  real length because `80mm auto` is invalid CSS Paged Media and falls back to
  Letter.
- On the Windows till, launch the browser with `--kiosk-printing` for silent
  printing.

---

## 6. Configuration

`.env.local` (gitignored), see `.env.example`:

| Variable | Needed | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Shared storefront project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Publishable key; safe in browser only because of RLS |
| `POS_RECEIPT_EMAIL_WEBHOOK` | No | Server-side only; unset means `/api/pos/receipt-email` returns `501` |

Without the Supabase values the till still runs: no roster, empty catalogue, and
the header says **Offline only**. Nothing crashes and nothing pretends to have
synced.

### Database setup

```bash
npx supabase link --project-ref <ref>
npx supabase db push
npx supabase db push --include-seed   # optional demo staff
```

Migrations `001–011` are mirrored from the storefront and must never be edited
here. The POS owns `012–016`.

---

## 7. What works offline, and what does not

| Feature | Offline? | Notes |
| --- | --- | --- |
| Open `/login`, `/pos`, `/manager`, `/manager/staff` | Yes | Precached shell |
| Sign in with PIN | Yes | Roster and hashes cached in IndexedDB |
| Browse catalogue, search, scan | Yes | Catalogue cached; images via browser HTTP cache |
| Add to cart, discount, checkout | Yes | All local |
| Record a cash/M-Pesa/card sale | Yes | Dexie transaction |
| Print receipt | Yes | `window.print()` |
| Queue receipt email | Yes | Queued and retried |
| Manager dashboard | Yes | Reads local DB only |
| Cash drawer | Yes | Local `till_sessions` |
| Enrol a cashier | **No** | Requires Supabase insert |
| Push sales / refresh catalogue / roster | **No** | Retried when online |
| Deliver receipt email | **No** | Requires server and webhook |

---

## 8. Route addition conventions

If adding a screen under `/manager`, just create the page. The layout guard
applies automatically.

If adding a top-level authenticated screen, wrap it in `<RequireAuth>` (and pass
`role` when appropriate) and add `<SyncProvider />` if it needs sync state.

Navigation between offline-critical screens should use plain `<a href>` or
`window.location.replace`, not `next/link`. The service worker answers document
requests from cache; client-side navigation needs a server RSC payload.

New routes under `app/` are statically prerendered when possible because
`cacheComponents: true` is enabled in `next.config.ts`. Keep server components
free of IndexedDB access; use client components and effects for device APIs.

---

## 9. Verification checklist

### Build

```bash
pnpm lint
pnpm build
test -f public/sw.js && echo "service worker written"
```

### Manual offline run

1. `pnpm build && pnpm start`, open `/pos`, sign in as the cashier.
2. DevTools → Network → Offline. The header pill goes red.
3. Add products, apply the 10% discount, charge, take payment. The sale saves
   and the receipt renders.
4. Repeat with Card and a reference.
5. Scan with no field focused → product added. Focus the search box and scan →
   code lands in the box; Enter adds it.
6. Visit `/manager` as the cashier → bounced to `/pos`, still offline.
7. Sign out, sign in as manager. The sale appears as **Saved locally**; the
   day's figures include it.
8. Open the till with a float, take a sale, close it with a count, and read the
   variance.
9. Go online. The queue drains, the row flips to **Synced**, pending returns to
   zero.
10. Confirm in Supabase that `pos_sales` has the `client_uuid`, lines are in
    `pos_sale_items`, and stock decreased.
11. Print the receipt and confirm the 80mm preview hides the app.

### Database checks

Run as `anon`, never with the service role in the browser:

- a sale pushes once and decrements stock once;
- replaying the same `client_uuid` returns `false` and does not duplicate;
- a sale with no lines is refused;
- `pos_sales` cannot be read back;
- `pos_users` can be read but not updated or deleted;
- a cashier insert with `role = 'manager'` is refused by `016`.

---

## 10. Analysis findings and risks

These are observations from reading the code, ordered by practical impact.
Nothing here was changed as part of this analysis.

### High — hard-coded `9999` manager bypass

**Files:** `components/auth/pin-login.tsx` (the `candidate === "9999"` branch),
`lib/auth.ts` (`verifyPin` generates a hash of `9999` on every call).

- Any person who types `9999` becomes a manager with `id: "temp-manager-id"`,
  regardless of the roster.
- `verifyPin` also returns `true` for `9999` against every user, so the bypass
  is not limited to the fake session branch.
- The fake id is **not a UUID**. `pos_record_sale` declares `p_cashier_id uuid`,
  so a sale rung up under this session is likely to fail syncing with an invalid
  UUID error and stay in the error queue.
- These are explicitly marked “TEMPORARY FIX”; remove both before production and
  fix the underlying hash for `9999` in the seed instead.

### High — plaintext PINs and hashes are logged

**Files:** `lib/auth.ts`, `components/auth/pin-login.tsx`,
`components/supabase-connection-check.tsx`, and the roster effect's
`console.log`.

The code logs:

- every attempted PIN,
- the stored bcrypt hash,
- a freshly generated hash for `9999`,
- the full local roster.

Anyone with DevTools or remote log capture can read these. Remove all PIN/hash
logging; a production till should never print credentials.

### Medium — the role guard is editable client state

The session lives in `localStorage` and the manager check is client-side. A
cashier can edit `pedigree-pos.session` and become a manager. This is documented
in `README.md` and `lib/auth.ts` as a Phase 1 tradeoff, not an accident. Real
enforcement requires a server session or device tokens.

### Medium — anon can read PIN hashes and create cashiers

- `012` deliberately allows `SELECT` on `pos_users` so offline PIN checks work.
  A 4-digit PIN has only 10,000 possibilities; a leaked hash is effectively a
  leaked PIN.
- `016` allows `INSERT` of `role = 'cashier'` rows for anyone holding the anon
  key. A cashier who edits `localStorage` can reach `/manager/staff` and enrol
  accounts.
- The documented fix is device-token enrolment plus network PIN verification
  with a short-lived offline assertion.

### Medium — receipt-email endpoint has no authentication

`POST /api/pos/receipt-email` accepts any caller and forwards to the configured
webhook. It validates shape but not origin, identity, or rate. If the deployment
is public, add authentication/rate limiting or restrict it at the edge.

### Medium — PIN length contract is inconsistent

- `lib/auth.ts` sets `PIN_MIN_LENGTH = 4` and `PIN_MAX_LENGTH = 4`.
- `isValidPinFormat` checks 4–6 digits.
- `lib/staff.ts` throws “The PIN must be 4 to 6 digits.”
- The staff form's `maxLength` is 4.

The UI and error message disagree with the actual maximum. Pick one rule and make
the constant, validator, message, and input agree.

### Low — PIN uniqueness is enforced only on the device

`createCashier` refuses a PIN already used by an active local user, but the
database has no unique constraint on `pin_hash`. Two tills enrolling the same PIN
concurrently can create an ambiguity, and sign-in is “first matching hash wins”
with no user picker.

### Low — sync order documentation drift

Code order is sales → products → users → emails. `README.md` and the header
comment in `lib/sync.ts` say sales → receipts → products → users. Update one to
match the other, or the next person will reason about the wrong ordering.

### Low — `pos_daily_totals` is unused

`012` defines a server-side aggregate RPC for manager reports, but the dashboard
computes totals from IndexedDB. The function is still part of the anon surface.
Either use it for cross-till reporting or document it as reserved for Phase 3.

### Low — no automated test suite

The repository has no test files or test script. Verification is manual plus the
headless device-path checks described in `README.md`. The pure pieces
(`lib/cart.ts`, `lib/sales.ts` arithmetic, `lib/time.ts`) are the easiest places
to start with unit tests.

### Low — diagnostic and starter leftovers

- `SupabaseConnectionCheck` is mounted on `/login` and only logs to the console.
- `public/file.svg`, `globe.svg`, `next.svg`, `vercel.svg`, and `window.svg` are
  unused starter assets.
- `PIN_HINT` in `pin-login.tsx` is declared but unused.
- There is no custom 404 page.

### Note — migrations are partly mirrored

`supabase/migrations/` contains `001–004`, `006–016`; there is no `005`. The
README explains that `001–011` are storefront mirrors. Do not edit those here;
change them in the storefront and re-mirror. Only `012–016` belong to the POS.

---

## 11. Quick reference: which file owns what

| Concern | File |
| --- | --- |
| Route guard | `components/require-auth.tsx` |
| Session storage and PIN hashing | `lib/auth.ts` |
| Auth React context | `components/auth-provider.tsx`, `hooks/use-auth.ts` |
| Local schema and types | `lib/db.ts` |
| Sale recording and totals | `lib/sales.ts` |
| Cart rules | `lib/cart.ts` |
| Sync engine | `lib/sync.ts` |
| Cash drawer | `lib/till.ts` |
| Cashier enrolment | `lib/staff.ts` |
| EAT date handling | `lib/time.ts` |
| Money/date formatting | `lib/format.ts` |
| Supabase client | `lib/supabase/client.ts` |
| Receipt email API | `app/api/pos/receipt-email/route.ts` |
| PWA manifest | `app/manifest.ts` |
| Service worker | `app/sw.ts` |
| Print rules | `app/globals.css` |
| Receipt layout | `components/pos/receipt.tsx` |
| Database policies/RPCs | `supabase/migrations/012–016` |

---

*End of guide.*
