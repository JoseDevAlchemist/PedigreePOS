-- ===========================================================================
-- 004_order_status.sql — updated order status flow + status history
-- ===========================================================================
-- Run this in the Supabase SQL Editor, or with the Supabase CLI:
--   supabase db push                      (from a linked project)
--   supabase migration up                 (local dev stack)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Update orders status constraint with new flow
-- ---------------------------------------------------------------------------
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
  'pending_payment',
  'paid',
  'preparing',
  'ready_for_delivery',
  'out_for_delivery',
  'delivered',
  'cancelled'
));

-- Update default status for new orders
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'pending_payment';

-- ---------------------------------------------------------------------------
-- order_status_history — tracks all status transitions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  changed_by_email text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON order_status_history(order_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE order_status_history ENABLE ROW LEVEL SECURITY;

-- Public can read history for their order (via order_id — same access as orders)
DROP POLICY IF EXISTS "Anyone can read order status history" ON order_status_history;
CREATE POLICY "Anyone can read order status history"
  ON order_status_history FOR SELECT TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM orders WHERE orders.id = order_status_history.order_id
    )
  );

-- Authenticated admins can insert/update
DROP POLICY IF EXISTS "Admins insert order status history" ON order_status_history;
CREATE POLICY "Admins insert order status history"
  ON order_status_history FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Admins update order status history" ON order_status_history;
CREATE POLICY "Admins update order status history"
  ON order_status_history FOR UPDATE TO authenticated USING (true) WITH CHECK (true);