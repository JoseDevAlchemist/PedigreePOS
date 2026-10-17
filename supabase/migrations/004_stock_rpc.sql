-- ===========================================================================
-- 004_stock_rpc.sql — RPC function for atomic stock decrement
-- ===========================================================================
--
-- Run this in the Supabase SQL Editor, or with the Supabase CLI:
--
--   supabase db push                      (from a linked project)
--   supabase migration up                 (local dev stack)
-- ===========================================================================

-- Function to atomically decrement stock quantity with a check.
-- Returns the new stock quantity on success, or raises an exception if insufficient stock.
CREATE OR REPLACE FUNCTION decrement_stock(
  product_id uuid,
  qty integer
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  new_quantity integer;
BEGIN
  -- Atomic update with check
  UPDATE products
  SET stock_quantity = stock_quantity - qty,
      updated_at = now()
  WHERE id = product_id
    AND stock_quantity >= qty
  RETURNING stock_quantity
  INTO new_quantity;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient stock for product %', product_id
      USING ERRCODE = 'insufficient_stock';
  END IF;

  RETURN new_quantity;
END;
$$;