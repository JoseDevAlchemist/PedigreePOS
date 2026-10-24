-- ===========================================================================
-- 020_pos_returns_ledger.sql — refunds and over-return protection
-- ===========================================================================
--
-- Run after 019_pos_product_creation.sql, in the same shared project.
--
-- 017 recorded that a return happened; 019 made its optional references safe.
-- This migration completes the money side and makes the return RPC reject a
-- return for more units than the sale still has outstanding.
--
-- The till keeps its own return ledger in Dexie and applies the same check
-- locally. This server check is the boundary for a caller that talks to the
-- RPC directly.

-- ---------------------------------------------------------------------------
-- Refund fields
-- ---------------------------------------------------------------------------
-- Whole shillings, like every other money column. Zero is a stock-only return.
ALTER TABLE pos_returns
  ADD COLUMN IF NOT EXISTS refund_kes integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_method text,
  ADD COLUMN IF NOT EXISTS refund_reference text;

ALTER TABLE pos_returns
  DROP CONSTRAINT IF EXISTS pos_returns_refund_kes_check;
ALTER TABLE pos_returns
  ADD CONSTRAINT pos_returns_refund_kes_check CHECK (refund_kes >= 0);

ALTER TABLE pos_returns
  DROP CONSTRAINT IF EXISTS pos_returns_refund_method_check;
ALTER TABLE pos_returns
  ADD CONSTRAINT pos_returns_refund_method_check CHECK (
    refund_method IS NULL
    OR refund_method IN ('cash', 'mpesa', 'card')
  );

ALTER TABLE pos_returns
  DROP CONSTRAINT IF EXISTS pos_returns_refund_method_required_check;
ALTER TABLE pos_returns
  ADD CONSTRAINT pos_returns_refund_method_required_check CHECK (
    refund_kes = 0 OR refund_method IS NOT NULL
  );

COMMENT ON COLUMN pos_returns.refund_kes IS
  'Whole shillings handed back to the customer. Zero means a stock-only return.';
COMMENT ON COLUMN pos_returns.refund_method IS
  'How the refund was paid: cash, mpesa or card. NULL when refund_kes is zero.';
COMMENT ON COLUMN pos_returns.refund_reference IS
  'M-Pesa code or card slip reference for the refund, when there was one.';

-- The over-return check reads previous returns for one sale; the item check
-- reads all lines for one return. Both are small, but neither should scan the
-- whole ledger as the shop accumulates history.
CREATE INDEX IF NOT EXISTS idx_pos_returns_original_sale
  ON pos_returns (original_sale_id);
CREATE INDEX IF NOT EXISTS idx_pos_return_items_product
  ON pos_return_items (product_id);

-- ---------------------------------------------------------------------------
-- pos_record_return — refunds, idempotency and over-return protection
-- ---------------------------------------------------------------------------
-- The return-table columns and the function arguments changed together, so the
-- old seven-argument function is dropped rather than left as a second overload.
DROP FUNCTION IF EXISTS pos_record_return(
  uuid, uuid, uuid, text, uuid, text, jsonb
);

CREATE OR REPLACE FUNCTION pos_record_return(
  p_client_uuid uuid,
  p_original_sale_id uuid,
  p_cashier_id uuid,
  p_cashier_name text,
  p_manager_id uuid,
  p_manager_name text,
  p_items jsonb,
  p_refund_kes integer,
  p_refund_method text,
  p_refund_reference text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_return_id uuid;
  v_original_sale_id uuid;
  v_cashier_id uuid;
  v_manager_id uuid;
  v_refund_kes integer := COALESCE(p_refund_kes, 0);
  v_refund_method text := nullif(btrim(p_refund_method), '');
  v_refund_reference text := nullif(btrim(p_refund_reference), '');
  v_overreturn text;
BEGIN
  IF p_client_uuid IS NULL THEN
    RAISE EXCEPTION 'A return must carry the client_uuid it was given at the till'
      USING ERRCODE = 'not_null_violation';
  END IF;

  -- A replay is free: do not validate the request again, and do not touch
  -- stock. The insert below has the same guard for two callers racing.
  IF EXISTS (
    SELECT 1 FROM pos_returns r WHERE r.client_uuid = p_client_uuid
  ) THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'A return must carry at least one line item'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_refund_kes < 0 THEN
    RAISE EXCEPTION 'A refund cannot be negative'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_refund_kes > 0 AND v_refund_method IS NULL THEN
    RAISE EXCEPTION 'A refund must say how the money was paid'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_refund_method IS NOT NULL
     AND v_refund_method NOT IN ('cash', 'mpesa', 'card') THEN
    RAISE EXCEPTION 'The refund method must be cash, mpesa or card'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Reject a zero/negative/fractional quantity before it reaches a CHECK and
  -- produces a less useful error. The table still owns the final constraint.
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) AS elem
    WHERE (elem ->> 'quantity') IS NULL
       OR (elem ->> 'quantity') !~ '^[0-9]+$'
       OR (elem ->> 'quantity')::integer <= 0
  ) THEN
    RAISE EXCEPTION 'Every return line needs a positive whole-number quantity'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Resolve the optional foreign keys. A scalar subquery returns NULL when
  -- the row is absent, which is exactly the desired durable meaning.
  v_original_sale_id := (
    SELECT s.id FROM pos_sales s WHERE s.id = p_original_sale_id
  );
  v_cashier_id := (
    SELECT u.id FROM pos_users u WHERE u.id = p_cashier_id
  );
  v_manager_id := (
    SELECT u.id FROM pos_users u WHERE u.id = p_manager_id
  );

  INSERT INTO pos_returns (
    client_uuid, original_sale_id, cashier_id, cashier_name,
    manager_id, manager_name, created_at,
    refund_kes, refund_method, refund_reference
  )
  VALUES (
    p_client_uuid, v_original_sale_id, v_cashier_id, coalesce(p_cashier_name, ''),
    v_manager_id, coalesce(p_manager_name, ''), now(),
    v_refund_kes, v_refund_method, v_refund_reference
  )
  ON CONFLICT (client_uuid) DO NOTHING
  RETURNING id INTO v_return_id;

  -- Already recorded: a replayed sync is a no-op, stock is not touched again.
  IF v_return_id IS NULL THEN
    RETURN false;
  END IF;

  -- The sale has to have the units before they can be returned. Compare the
  -- requested quantity with what was sold, less every previous return for the
  -- same sale and product. The just-inserted return has no lines yet, so it
  -- does not count against itself.
  --
  -- Only products still identifiable on the sale can be checked. A hard-deleted
  -- product becomes NULL on pos_sale_items, and the line must still be
  -- recordable (B13); the till's ledger applies the stronger local check.
  IF v_original_sale_id IS NOT NULL THEN
    WITH requested AS (
      SELECT
        nullif(elem ->> 'product_id', '')::uuid AS product_id,
        sum((elem ->> 'quantity')::integer)::integer AS requested
      FROM jsonb_array_elements(p_items) AS elem
      WHERE nullif(elem ->> 'product_id', '') IS NOT NULL
      GROUP BY 1
    ),
    sold AS (
      SELECT
        si.product_id,
        sum(si.quantity)::integer AS sold,
        min(si.product_name) AS product_name
      FROM pos_sale_items si
      WHERE si.sale_id = v_original_sale_id
        AND si.product_id IS NOT NULL
      GROUP BY si.product_id
    ),
    already AS (
      SELECT
        ri.product_id,
        sum(ri.quantity)::integer AS returned
      FROM pos_return_items ri
      JOIN pos_returns r ON r.id = ri.return_id
      WHERE r.original_sale_id = v_original_sale_id
        AND ri.product_id IS NOT NULL
      GROUP BY ri.product_id
    )
    SELECT string_agg(
      format(
        '%s (sold %s, already returned %s, requested %s)',
        sold.product_name,
        sold.sold,
        coalesce(already.returned, 0),
        req.requested
      ),
      '; '
    )
    INTO v_overreturn
    FROM requested req
    JOIN sold ON sold.product_id = req.product_id
    LEFT JOIN already ON already.product_id = req.product_id
    WHERE req.requested > greatest(
      sold.sold - coalesce(already.returned, 0),
      0
    );

    IF v_overreturn IS NOT NULL THEN
      RAISE EXCEPTION 'Return exceeds the units sold on sale %: %',
        v_original_sale_id, v_overreturn
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  INSERT INTO pos_return_items (return_id, product_id, product_name, quantity)
  SELECT
    v_return_id,
    -- LEFT JOIN is the product foreign-key resolution: no matching product
    -- yields NULL, and the line still records its name and quantity.
    p.id,
    elem ->> 'product_name',
    (elem ->> 'quantity')::integer
  FROM jsonb_array_elements(p_items) AS elem
  LEFT JOIN products p
    ON p.id = nullif(elem ->> 'product_id', '')::uuid;

  -- Put the stock back on the shelf, once per product. A product may have been
  -- delisted since the sale; the join silently skips it rather than failing
  -- the return.
  UPDATE products p
     SET stock_quantity = p.stock_quantity + i.quantity
    FROM (
      SELECT product_id, sum(quantity)::integer AS quantity
      FROM pos_return_items
      WHERE return_id = v_return_id
        AND product_id IS NOT NULL
      GROUP BY product_id
    ) i
   WHERE p.id = i.product_id;

  RETURN true;
END;
$$;

COMMENT ON FUNCTION pos_record_return(
  uuid, uuid, uuid, text, uuid, text, jsonb, integer, text, text
) IS
  'The till''s only return write path. Records a return, its lines and refund, restocks known products, treats unknown optional ids as NULL, rejects over-returns for products still identifiable on the sale, and is idempotent on p_client_uuid.';

REVOKE ALL ON FUNCTION pos_record_return(
  uuid, uuid, uuid, text, uuid, text, jsonb, integer, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pos_record_return(
  uuid, uuid, uuid, text, uuid, text, jsonb, integer, text, text
) TO anon, authenticated;
