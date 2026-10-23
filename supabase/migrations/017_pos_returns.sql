-- ===========================================================================
-- 017_pos_returns.sql — manager-approved returns and website publishing
-- ===========================================================================
--
-- Run after 016_pos_staff_enrolment.sql, in the same shared project.
--
-- ---------------------------------------------------------------------------
-- products.is_website_published
-- ---------------------------------------------------------------------------
-- A product a manager adds from the till must not accidentally reach the
-- storefront. This flag defaults false and is flipped deliberately.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_website_published boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- pos_returns / pos_return_items
-- ---------------------------------------------------------------------------
-- A return reverses a sale's stock decrement: goods came back across the
-- counter, so stock goes back up. A return always carries the manager who
-- approved it, for audit.
CREATE TABLE IF NOT EXISTS pos_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The idempotency key: a replayed sync of the same return is a no-op.
  client_uuid uuid NOT NULL UNIQUE,

  original_sale_id uuid REFERENCES pos_sales (id) ON DELETE SET NULL,
  cashier_id uuid REFERENCES pos_users (id) ON DELETE SET NULL,
  cashier_name text NOT NULL,

  manager_id uuid REFERENCES pos_users (id) ON DELETE SET NULL,
  manager_name text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  synced_at timestamptz
);

CREATE TABLE IF NOT EXISTS pos_return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  return_id uuid NOT NULL REFERENCES pos_returns (id) ON DELETE CASCADE,
  product_id uuid REFERENCES products (id) ON DELETE SET NULL,
  product_name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_pos_returns_created ON pos_returns (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_return_items_return ON pos_return_items (return_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE pos_returns      ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_return_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "The till can record a return" ON pos_returns;
CREATE POLICY "The till can record a return"
  ON pos_returns FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "The till can record return items" ON pos_return_items;
CREATE POLICY "The till can record return items"
  ON pos_return_items FOR INSERT TO anon, authenticated WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- pos_record_return — record a return and put the stock back
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER: the till's anon key may not UPDATE products directly, so
-- this single function is the only write path — record the return, insert its
-- lines, and increment the affected products' stock. Idempotent on
-- client_uuid so a retried sync never puts stock back twice.
CREATE OR REPLACE FUNCTION pos_record_return(
  p_client_uuid uuid,
  p_original_sale_id uuid,
  p_cashier_id uuid,
  p_cashier_name text,
  p_manager_id uuid,
  p_manager_name text,
  p_items jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_return_id uuid;
BEGIN
  INSERT INTO pos_returns (
    client_uuid, original_sale_id, cashier_id, cashier_name,
    manager_id, manager_name, created_at
  )
  VALUES (
    p_client_uuid, p_original_sale_id, p_cashier_id, p_cashier_name,
    p_manager_id, p_manager_name, now()
  )
  ON CONFLICT (client_uuid) DO NOTHING
  RETURNING id INTO v_return_id;

  -- Already recorded: a replayed sync is a no-op, stock is not touched again.
  IF v_return_id IS NULL THEN
    RETURN false;
  END IF;

  INSERT INTO pos_return_items (return_id, product_id, product_name, quantity)
  SELECT
    v_return_id,
    (elem ->> 'product_id')::uuid,
    elem ->> 'product_name',
    (elem ->> 'quantity')::integer
  FROM jsonb_array_elements(p_items) AS elem;

  -- Put the stock back on the shelf. A product may have been delisted since
  -- the sale; the join silently skips it rather than failing the return.
  UPDATE products p
     SET stock_quantity = p.stock_quantity + i.quantity
    FROM (
      SELECT
        (elem ->> 'product_id')::uuid AS product_id,
        (elem ->> 'quantity')::integer AS quantity
      FROM jsonb_array_elements(p_items) AS elem
    ) i
   WHERE p.id = i.product_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION pos_record_return(
  uuid, uuid, uuid, text, uuid, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pos_record_return(
  uuid, uuid, uuid, text, uuid, text, jsonb
) TO anon, authenticated;
