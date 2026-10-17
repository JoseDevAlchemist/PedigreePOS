-- ===========================================================================
-- 012_pos.sql — point of sale: staff, sales, and sale lines
-- ===========================================================================
--
-- This migration belongs to the SHARED Supabase project. The storefront's
-- migrations run 001–011; this is the POS's first, and it must be applied to
-- the same project the storefront uses. Run it in the Supabase SQL Editor, or
-- with the Supabase CLI from a linked project:
--
--   supabase db push
--
-- SQL Editor: Dashboard -> SQL Editor -> New query -> paste this whole file ->
-- Run. Safe to run twice; every statement is guarded.
--
-- ---------------------------------------------------------------------------
-- Why its own tables, and not `orders`
-- ---------------------------------------------------------------------------
-- A POS sale and a web order look alike and are not. A web order is a promise:
-- it has a delivery method, a fulfilment status, a payment that settles the
-- next day. A POS sale is a fact: the money changed hands across a counter and
-- the receipt is already printed. Forcing both into `orders` would mean every
-- query in the storefront admin filtering out rows it never wanted, and every
-- constraint in `orders` (delivery_method NOT NULL, an order_number sequence)
-- becoming a lie for half the table.
--
-- So: `pos_sales` and `pos_sale_items`, separate from `orders`.
--
-- ---------------------------------------------------------------------------
-- Why every id is client-generated
-- ---------------------------------------------------------------------------
-- The till writes a sale while offline and syncs it later, possibly more than
-- once (a retry after a timeout that actually succeeded). Idempotency therefore
-- cannot depend on the server minting an id. The client generates one uuid and
-- uses it for BOTH `id` and `client_uuid`:
--
--   * `client_uuid` is the conflict target for `upsert(..., { onConflict:
--     'client_uuid', ignoreDuplicates: true })`, so a replayed sync is a no-op.
--   * using the same value for `id` means `pos_sale_items.sale_id` can be sent
--     in the same round trip, with no read-back to learn a server-assigned id.
--
-- A uuid is generated once, at the moment of the sale, and never changes.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- products.barcode — the scanner's key
-- ---------------------------------------------------------------------------
-- Additive and nullable: the storefront neither sets nor reads it, and a
-- product without a barcode is still sellable via search. Partial unique index
-- because barcodes are only unique where present — many products have none, and
-- NULLs must not collide.
ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode
  ON products (barcode)
  WHERE barcode IS NOT NULL;


-- ---------------------------------------------------------------------------
-- pos_users — till staff
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name text NOT NULL,

  -- bcrypt. Never a PIN, and never reversible to one. The hash is compared on
  -- the device (see lib/auth.ts) so sign-in survives a dropped connection.
  pin_hash text NOT NULL,

  role text NOT NULL CHECK (role IN ('cashier', 'manager')),

  -- Leaving staff are deactivated, not deleted: their sales must keep a name
  -- attached. Deactivate and the roster sync stops sending them.
  active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now()
);


-- ---------------------------------------------------------------------------
-- pos_sales
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos_sales (
  id uuid PRIMARY KEY,

  -- The idempotency key. See the header note.
  client_uuid uuid NOT NULL UNIQUE,

  -- Nullable and ON DELETE SET NULL: a deleted staff account must not make the
  -- sale unsyncable. `cashier_name` is the durable record of who rang it up.
  cashier_id uuid REFERENCES pos_users (id) ON DELETE SET NULL,
  cashier_name text NOT NULL,

  -- Whole shillings, integers. Kenya does not quote cents on leather goods and
  -- float arithmetic would put rounding drift in the day's takings.
  subtotal_kes integer NOT NULL DEFAULT 0 CHECK (subtotal_kes >= 0),
  discount_kes integer NOT NULL DEFAULT 0 CHECK (discount_kes >= 0),
  discount_percent integer NOT NULL DEFAULT 0
    CHECK (discount_percent >= 0 AND discount_percent <= 100),
  total_kes integer NOT NULL CHECK (total_kes >= 0),

  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'mpesa')),

  -- Cash only.
  amount_tendered integer CHECK (amount_tendered IS NULL OR amount_tendered >= 0),
  change_due integer CHECK (change_due IS NULL OR change_due >= 0),

  -- M-Pesa only: the confirmation code the cashier read off the customer's
  -- phone. Free text because the format varies and rejecting an unusual one
  -- would block a real sale.
  mpesa_code text,

  -- When the sale happened on the till. Authoritative over `synced_at` for
  -- reporting: a sale made offline on Friday and synced on Monday is a Friday
  -- sale.
  created_at timestamptz NOT NULL DEFAULT now(),

  -- When the server received it. Null until the sync lands.
  synced_at timestamptz,

  CONSTRAINT pos_sales_payment_details CHECK (
    (payment_method = 'cash'  AND mpesa_code IS NULL)
    OR
    (payment_method = 'mpesa' AND amount_tendered IS NULL AND change_due IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_pos_sales_created ON pos_sales (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_sales_cashier ON pos_sales (cashier_id);
CREATE INDEX IF NOT EXISTS idx_pos_sales_pending ON pos_sales (synced_at)
  WHERE synced_at IS NULL;


-- ---------------------------------------------------------------------------
-- pos_sale_items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pos_sale_items (
  id uuid PRIMARY KEY,

  sale_id uuid NOT NULL REFERENCES pos_sales (id) ON DELETE CASCADE,

  -- Nullable: a product may be removed from the catalogue after it was sold,
  -- and the sale line must survive that.
  product_id uuid REFERENCES products (id) ON DELETE SET NULL,

  -- Denormalised on purpose. A receipt reprinted a year later must show the
  -- name and price as they were, not as the catalogue reads now.
  product_name text NOT NULL,

  quantity integer NOT NULL CHECK (quantity > 0),
  price_at_sale integer NOT NULL CHECK (price_at_sale >= 0),

  -- One line per product per sale: the cart merges repeats before checkout.
  -- This is also the conflict target that keeps a replayed sync a no-op even if
  -- the client somehow sent the same item twice.
  UNIQUE (sale_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_pos_sale_items_sale ON pos_sale_items (sale_id);


-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE pos_users      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_sales      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_sale_items ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- pos_users — read-only to the app
-- ---------------------------------------------------------------------------
-- DELIBERATE TRADEOFF, READ BEFORE "FIXING" THIS.
--
-- The till verifies a PIN with bcrypt *on the device*, because sign-in has to
-- work with no network. That is only possible if the device already holds the
-- hashes, which means the app's key (anon) must be able to SELECT `pin_hash`.
--
-- The consequence: anyone holding the publishable anon key can read the
-- bcrypt hashes and attack them offline. A 4-digit PIN has 10,000
-- possibilities, so assume they fall. This is acceptable for Phase 1 only
-- because the anon key is already public, the PIN guards a shared shop floor,
-- and the real money movement is recorded server-side regardless.
--
-- The fix, when the POS gets a server: stop syncing hashes to the client.
-- Issue each till a device token at enrolment, verify the PIN against a
-- SECURITY DEFINER function over the network, and cache only a short-lived
-- signed assertion for offline use. Tracked for Phase 2.
DROP POLICY IF EXISTS "pos_users are readable by the till" ON pos_users;
CREATE POLICY "pos_users are readable by the till"
  ON pos_users FOR SELECT TO anon, authenticated USING (true);

-- No INSERT/UPDATE/DELETE policy at all: with RLS on and no permissive policy,
-- writing is denied to anon and authenticated. Staff are managed in the
-- dashboard or by seeded SQL (see supabase/pos_seed.sql).

-- ---------------------------------------------------------------------------
-- pos_sales / pos_sale_items — write-only to the app
-- ---------------------------------------------------------------------------
-- The till pushes sales up and never reads them back; the manager reports read
-- from the local database. So the app gets INSERT and nothing else. Customer
-- takings are therefore not readable with the publishable key, which is the
-- point.
--
-- SUPERSEDED BY 014. These two policies are dropped there, because
-- `upsert(..., { ignoreDuplicates: true })` turned out not to work against a
-- table the caller may not read: `ON CONFLICT DO NOTHING` needs to see the
-- conflicting row, and there is no SELECT policy here for it to use. The write
-- path is now the `pos_record_sale` function in 014. Left here so that 012
-- still describes the schema as it was applied.
DROP POLICY IF EXISTS "The till can record a sale" ON pos_sales;
CREATE POLICY "The till can record a sale"
  ON pos_sales FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "The till can record sale items" ON pos_sale_items;
CREATE POLICY "The till can record sale items"
  ON pos_sale_items FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- The day's takings, for the manager dashboard
-- ---------------------------------------------------------------------------
-- A manager reporting on the till needs a rollup, not the raw rows. This is
-- SECURITY DEFINER so it can read `pos_sales` on the caller's behalf without
-- granting them SELECT on the table. It returns aggregates only — no customer
-- or line detail leaks through it.
CREATE OR REPLACE FUNCTION pos_daily_totals(p_day date DEFAULT current_date)
RETURNS TABLE (
  payment_method text,
  sale_count bigint,
  gross_kes bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.payment_method,
    count(*)::bigint,
    sum(s.total_kes)::bigint
  FROM pos_sales s
  WHERE s.created_at >= p_day
    AND s.created_at < p_day + interval '1 day'
  GROUP BY s.payment_method
  ORDER BY s.payment_method;
$$;

REVOKE ALL ON FUNCTION pos_daily_totals(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pos_daily_totals(date) TO anon, authenticated;
