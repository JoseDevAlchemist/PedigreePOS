-- ===========================================================================
-- 003_orders.sql — orders and order items
-- ===========================================================================
--
-- Run this in the Supabase SQL Editor, or with the Supabase CLI:
--
--   supabase db push                      (from a linked project)
--   supabase migration up                 (local dev stack)
--
-- SQL Editor: Dashboard -> SQL Editor -> New query -> paste this whole file ->
-- Run. It is safe to run twice; every statement is guarded.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Format: PED-YYYY-XXXX (e.g., PED-2026-0001)
  -- Unique per year, zero-padded 4-digit sequence.
  order_number text NOT NULL UNIQUE,

  customer_name text NOT NULL,
  customer_email text,
  customer_phone text NOT NULL,

  delivery_method text NOT NULL CHECK (delivery_method IN ('delivery', 'pickup')),
  delivery_address text,
  delivery_fee integer NOT NULL DEFAULT 0,

  subtotal integer NOT NULL,
  discount_total integer NOT NULL DEFAULT 0,
  total integer NOT NULL,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled')),

  payment_method text CHECK (payment_method IN ('mpesa', 'card', 'pay_on_delivery')),
  payment_status text NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),

  notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- order_items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,

  -- Denormalised for order history: the product may be deleted later,
  -- but the order must still show what the customer bought.
  product_id uuid NOT NULL REFERENCES products(id),
  product_name text NOT NULL,
  product_slug text NOT NULL,

  color_name text NOT NULL,
  color_hex text NOT NULL,

  unit_price integer NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  line_total integer NOT NULL
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

-- Public can INSERT orders (guest checkout), but not SELECT/list them
DROP POLICY IF EXISTS "Anyone can create an order" ON orders;
CREATE POLICY "Anyone can create an order"
  ON orders FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Anyone can create order items" ON order_items;
CREATE POLICY "Anyone can create order items"
  ON order_items FOR INSERT TO anon, authenticated WITH CHECK (true);

-- Only authenticated admins can read/update orders
DROP POLICY IF EXISTS "Admins read all orders" ON orders;
CREATE POLICY "Admins read all orders"
  ON orders FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Admins update orders" ON orders;
CREATE POLICY "Admins update orders"
  ON orders FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Admins read all order items" ON order_items;
CREATE POLICY "Admins read all order items"
  ON order_items FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_updated_at ON orders;
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION update_updated_at();