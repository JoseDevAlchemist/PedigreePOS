-- ===========================================================================
-- 013_pos_stock.sql — apply a synced sale to the shared stock count
-- ===========================================================================
--
-- Run after 012_pos.sql, in the same shared Supabase project.
--
-- ---------------------------------------------------------------------------
-- The problem
-- ---------------------------------------------------------------------------
-- `products` is shared with the storefront, and its stock count is the one
-- number both apps must agree on. When the till sells a bag, the website must
-- show one fewer — otherwise a web customer can buy something that left the
-- shop yesterday.
--
-- The till cannot do that decrement itself. Anon has SELECT on `products` and
-- nothing else (001_initial.sql grants write access to `authenticated` only),
-- so an UPDATE from the POS is filtered to zero rows and fails silently, which
-- is the worst possible failure for a stock count.
--
-- ---------------------------------------------------------------------------
-- Why a function and not an UPDATE policy
-- ---------------------------------------------------------------------------
-- Opening `products` to UPDATE from anon would let anyone with the publishable
-- key set any price and any stock level. Instead this one SECURITY DEFINER
-- function exposes exactly one operation — "apply the stock for this sale" —
-- and nothing else.
--
-- ---------------------------------------------------------------------------
-- Why it is idempotent
-- ---------------------------------------------------------------------------
-- The sync is retried: a request that times out may still have committed. If
-- the decrement ran twice, the shop would lose stock that is really on the
-- shelf. So the decrement is guarded by `stock_applied_at` on the sale row,
-- read under `FOR UPDATE`. A second call — a retry, or a second till replaying
-- the same sale — finds the stamp already set and does nothing.
--
-- Note the deliberate `GREATEST(0, ...)`: stock never goes negative here and
-- the call never raises on an under-count. A sale that has already happened is
-- a fact, and a stock figure that disagrees with the shelf must not roll the
-- sale back. Reconciling the discrepancy is an admin job, not the till's.
-- ===========================================================================


ALTER TABLE pos_sales
  ADD COLUMN IF NOT EXISTS stock_applied_at timestamptz;

COMMENT ON COLUMN pos_sales.stock_applied_at IS
  'When this sale last decremented products.stock_quantity. Guards the decrement against a replayed sync.';


CREATE OR REPLACE FUNCTION pos_apply_sale_stock(p_client_uuid uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sale_id uuid;
  v_applied timestamptz;
BEGIN
  -- Lock the sale row for the duration. A concurrent second call for the same
  -- sale blocks here and, once unblocked, reads the stamp the winner wrote.
  SELECT id, stock_applied_at
    INTO v_sale_id, v_applied
    FROM pos_sales
   WHERE client_uuid = p_client_uuid
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No POS sale with client_uuid %', p_client_uuid
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Already applied. This is the whole point of the function.
  IF v_applied IS NOT NULL THEN
    RETURN false;
  END IF;

  UPDATE products p
     SET stock_quantity = GREATEST(0, p.stock_quantity - i.quantity)
    FROM pos_sale_items i
   WHERE i.sale_id = v_sale_id
     AND i.product_id IS NOT NULL
     AND p.id = i.product_id;

  UPDATE pos_sales SET stock_applied_at = now() WHERE id = v_sale_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION pos_apply_sale_stock(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pos_apply_sale_stock(uuid) TO anon, authenticated;
