-- ===========================================================================
-- 014_pos_record_sale.sql — record a whole sale in one call
-- ===========================================================================
--
-- Run after 012_pos.sql and 013_pos_stock.sql, in the same shared project.
--
-- ---------------------------------------------------------------------------
-- Why this migration exists
-- ---------------------------------------------------------------------------
-- 012 originally let the till write a sale itself, with
-- `upsert(..., { onConflict: 'client_uuid', ignoreDuplicates: true })`. That
-- does not work against a table the till may not read, and the failure lands on
-- the till, not here, so it is worth writing down:
--
--   POST /rest/v1/pos_sales?on_conflict=client_uuid
--   Prefer: resolution=ignore-duplicates
--   -> 401 {"code":"42501","message":"new row violates row-level security
--           policy for table \"pos_sales\""}
--
-- `ON CONFLICT DO NOTHING` is not a blind insert. Postgres has to *see* the
-- conflicting row to decide to skip it, and `pos_sales` has no SELECT policy
-- for `anon` — that is what keeps the day's takings unreadable with the
-- publishable key. Any `resolution=...` preference fails the same way, for the
-- same reason, whatever `return=` is set to; a plain INSERT is unaffected.
--
-- So the choice was: give `anon` SELECT on every sale (and lose the property),
-- or move the upsert somewhere it can read and the till cannot. This is the
-- second. The idempotency is unchanged — still `ON CONFLICT (client_uuid) DO
-- NOTHING`, still keyed on the uuid the till generates at the moment of sale —
-- it just runs with the function owner's eyes instead of the till's.
--
-- ---------------------------------------------------------------------------
-- What else this buys
-- ---------------------------------------------------------------------------
-- A sale, its lines and its stock decrement used to be three round trips. A
-- connection that died between them left a sale with no lines (and so no stock
-- decrement) until the next sync repaired it. Now it is one transaction: all of
-- it or none of it.
--
-- ---------------------------------------------------------------------------
-- This is now the only way to write a sale
-- ---------------------------------------------------------------------------
-- The INSERT policies from 012 are dropped below. `anon` can no longer reach
-- `pos_sales` or `pos_sale_items` directly at all; the only write path is this
-- function. That matters because the function is SECURITY DEFINER — it runs
-- past RLS — so the function *is* the boundary, and it is a narrower one than
-- `WITH CHECK (true)` was: one sale per call, fields from the table's own
-- CHECK constraints, lines tied to the sale that is being recorded.
--
-- The anon key remains public. What it can do is now, in full:
--
--   SELECT  products            (the catalogue)
--   SELECT  pos_users           (hashes, for offline PIN checks — see 012)
--   CALL    pos_record_sale     (this function)
--   CALL    pos_daily_totals    (aggregates only)
--
-- and nothing else. `pos_apply_sale_stock` loses its grant to `anon` for the
-- same reason: the till no longer calls it, this function does.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- The boundary, narrowed
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "The till can record a sale" ON pos_sales;
DROP POLICY IF EXISTS "The till can record sale items" ON pos_sale_items;

REVOKE EXECUTE ON FUNCTION pos_apply_sale_stock(uuid) FROM anon;


-- ---------------------------------------------------------------------------
-- pos_record_sale
-- ---------------------------------------------------------------------------
-- One argument per column rather than a single jsonb blob: Postgres then types
-- and validates the money on the way in, and a client bug shows up as a
-- function-argument error instead of a malformed row. `p_items` stays jsonb
-- because a sale has a variable number of lines.
--
-- Returns TRUE when the sale was recorded and FALSE when it was already there,
-- so the till can tell "pushed" from "this is a replay" without a second call.
CREATE OR REPLACE FUNCTION pos_record_sale(
  p_client_uuid uuid,
  p_cashier_id uuid,
  p_cashier_name text,
  p_subtotal_kes integer,
  p_discount_kes integer,
  p_discount_percent integer,
  p_total_kes integer,
  p_payment_method text,
  p_amount_tendered integer,
  p_change_due integer,
  p_mpesa_code text,
  p_created_at timestamptz,
  p_items jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted boolean;
BEGIN
  IF p_client_uuid IS NULL THEN
    RAISE EXCEPTION 'A sale must carry the client_uuid it was given at the till'
      USING ERRCODE = 'not_null_violation';
  END IF;

  -- Empty is refused rather than allowed: `completeSale` cannot produce one, so
  -- an empty array means the payload was mangled, and a sale with no lines
  -- would decrement no stock and read as a zero-item sale on every report.
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'A sale must carry at least one line item'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO pos_sales (
    id, client_uuid, cashier_id, cashier_name,
    subtotal_kes, discount_kes, discount_percent, total_kes,
    payment_method, amount_tendered, change_due, mpesa_code,
    created_at, synced_at
  )
  VALUES (
    -- One uuid for both, exactly as 012 describes: `client_uuid` is what makes
    -- a replayed sync a no-op, `id` is what the lines point at.
    p_client_uuid, p_client_uuid, p_cashier_id, p_cashier_name,
    p_subtotal_kes, p_discount_kes, p_discount_percent, p_total_kes,
    p_payment_method, p_amount_tendered, p_change_due, p_mpesa_code,
    coalesce(p_created_at, now()), now()
  )
  ON CONFLICT (client_uuid) DO NOTHING;

  v_inserted := FOUND;

  -- Lines go in even when the sale did not, so a push that died between the two
  -- is repaired by the retry instead of being skipped as "already synced".
  -- `id` is client-generated too, which is what keeps this idempotent.
  INSERT INTO pos_sale_items (
    id, sale_id, product_id, product_name, quantity, price_at_sale
  )
  SELECT
    (item ->> 'id')::uuid,
    p_client_uuid,
    -- `->>` gives SQL NULL for a JSON null or a missing key, so a sale line for
    -- a delisted product survives the round trip as product_id IS NULL.
    (item ->> 'product_id')::uuid,
    item ->> 'product_name',
    (item ->> 'quantity')::integer,
    (item ->> 'price_at_sale')::integer
  FROM jsonb_array_elements(p_items) AS item
  ON CONFLICT (id) DO NOTHING;

  -- Same transaction, same rows: the stock stamp from 013 still guards the
  -- decrement, so a replay of a sale that synced cleanly changes nothing.
  --
  -- Note what is deliberately *not* here: no cross-check that the lines add up
  -- to `subtotal_kes`, and no rejection when stock is short. A sale that has
  -- already happened is a fact — the receipt is printed and the goods are gone
  -- — so the server records it and leaves reconciliation to a human. Same
  -- reasoning as the GREATEST(0, ...) in 013.
  PERFORM pos_apply_sale_stock(p_client_uuid);

  RETURN v_inserted;
END;
$$;

COMMENT ON FUNCTION pos_record_sale(
  uuid, uuid, text, integer, integer, integer, integer, text,
  integer, integer, text, timestamptz, jsonb
) IS
  'The till''s only write path. Records a sale, its lines and its stock decrement atomically; idempotent on p_client_uuid. Returns true when newly recorded, false on a replay.';

REVOKE ALL ON FUNCTION pos_record_sale(
  uuid, uuid, text, integer, integer, integer, integer, text,
  integer, integer, text, timestamptz, jsonb
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION pos_record_sale(
  uuid, uuid, text, integer, integer, integer, integer, text,
  integer, integer, text, timestamptz, jsonb
) TO anon, authenticated;
