-- ===========================================================================
-- 019_pos_product_creation.sql — a safe write path for till-created products
-- ===========================================================================
--
-- Run after 018_pos_rotate_demo_manager_pin.sql, in the same shared project.
--
-- ---------------------------------------------------------------------------
-- The gap
-- ---------------------------------------------------------------------------
-- `products` is readable by the till because the catalogue is pulled for
-- offline selling, but it deliberately has no INSERT policy. `pushProduct`
-- currently tries `products.upsert(...)` with the anon key, so every product
-- created on the till fails with:
--
--   401 {"code":"42501","message":"new row violates row-level security
--          policy for table \"products\""}
--
-- The local product then survives only until the next successful catalogue
-- pull, which deletes rows the server does not have.
--
-- Opening `products` to anon INSERT would be worse: the publishable key is
-- public, and a direct insert can set any price, stock or publication flag.
-- The till gets a narrow SECURITY DEFINER function instead. It inserts one
-- product row, validates the fields a till can get wrong, and never updates an
-- existing row. Insert-only is what makes a retried sync idempotent and keeps
-- the function from clobbering a stock count another till or the storefront
-- changed.
--
-- ---------------------------------------------------------------------------
-- is_website_published backfill
-- ---------------------------------------------------------------------------
-- 017 added `is_website_published` with `DEFAULT false`. Every product that
-- already existed was a storefront product, so leaving those rows false would
-- empty the website the moment the storefront starts filtering on the flag.
-- The one-time UPDATE below marks the catalogue that existed before the till
-- had a product-creation path as published.
--
-- This migration must be applied before Feature C ships. After that, the flag
-- is an explicit decision on every new product: the RPC keeps its default
-- false, and only a manager who checks "Publish on website" sets it true.
--
-- The storefront filter is a separate deploy and must come after this file
-- (§7.6 in WEBVIEW.md). Reversing those steps takes the shop offline.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- One-time publication backfill
-- ---------------------------------------------------------------------------
-- Deliberately unconditional within the false rows: before this migration
-- there is no till path that creates a product, so every existing row is part
-- of the legacy catalogue. The notice makes the count visible in the
-- migration log without failing an empty database.
DO $$
DECLARE
  v_backfilled integer;
BEGIN
  UPDATE products
     SET is_website_published = true
   WHERE is_website_published = false;

  GET DIAGNOSTICS v_backfilled = ROW_COUNT;
  RAISE NOTICE 'Backfilled % existing product(s) as website-published', v_backfilled;
END;
$$;


-- ---------------------------------------------------------------------------
-- pos_create_product — the till's only product write path
-- ---------------------------------------------------------------------------
-- One argument per column, like `pos_record_sale`: Postgres types and checks
-- the money on the way in, and a client bug becomes a function-argument error
-- instead of a malformed row. `p_items` is not needed because a till-created
-- product has no sale lines yet; colours and images are local-only for now.
--
-- `ON CONFLICT (id) DO NOTHING` is the idempotency key. A retry after a
-- timeout that actually succeeded returns FALSE and changes nothing. The
-- function never updates: product editing is a separate feature with its own
-- boundary.
CREATE OR REPLACE FUNCTION pos_create_product(
  p_id uuid,
  p_name text,
  p_slug text,
  p_category text,
  p_barcode text,
  p_base_price integer,
  p_discount_percent integer,
  p_stock_quantity integer,
  p_is_website_published boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slug text;
  v_base_slug text;
  v_barcode text;
  v_attempt integer := 0;
  v_inserted boolean;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'A product must carry the id it was given at the till'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_name IS NULL OR length(trim(p_name)) < 2 THEN
    RAISE EXCEPTION 'A product needs a name'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_base_price IS NULL OR p_base_price <= 0 THEN
    RAISE EXCEPTION 'A product needs a positive price'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_category IS NULL OR p_category NOT IN ('bag', 'shoe') THEN
    RAISE EXCEPTION 'Unknown category %', p_category
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_stock_quantity IS NULL OR p_stock_quantity < 0 THEN
    RAISE EXCEPTION 'Stock cannot be negative'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_discount_percent IS NOT NULL
     AND (p_discount_percent < 0 OR p_discount_percent > 100) THEN
    RAISE EXCEPTION 'Discount must be between 0 and 100'
      USING ERRCODE = 'check_violation';
  END IF;

  -- A slug is a URL segment, not an identity. Normalise whatever arrived,
  -- then derive one from the name when the client did not send a usable value.
  v_slug := lower(regexp_replace(trim(coalesce(p_slug, '')), '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := trim(both '-' from v_slug);

  IF v_slug = '' THEN
    v_slug := lower(regexp_replace(trim(p_name), '[^a-zA-Z0-9]+', '-', 'g'));
    v_slug := trim(both '-' from v_slug);
  END IF;

  IF v_slug = '' THEN
    v_slug := 'product';
  END IF;

  -- A duplicate product name is not an error. Suffix with a slice of the
  -- client-generated id, which is unique; the loop only guards against the
  -- (very unlikely) case where another product already owns that suffix.
  v_base_slug := v_slug;
  WHILE EXISTS (
    SELECT 1 FROM products p WHERE p.slug = v_slug AND p.id <> p_id
  ) LOOP
    v_attempt := v_attempt + 1;
    v_slug := v_base_slug || '-' || left(replace(p_id::text, '-', ''), 8);
    IF v_attempt > 1 THEN
      v_slug := v_slug || '-' || v_attempt;
    END IF;
  END LOOP;

  v_barcode := nullif(trim(coalesce(p_barcode, '')), '');

  INSERT INTO products (
    id, name, slug, category, barcode,
    base_price, discount_percent, stock_quantity,
    active, is_website_published
  )
  VALUES (
    p_id, trim(p_name), v_slug, p_category, v_barcode,
    p_base_price, coalesce(p_discount_percent, 0), p_stock_quantity,
    true, coalesce(p_is_website_published, false)
  )
  ON CONFLICT (id) DO NOTHING;

  v_inserted := FOUND;
  RETURN v_inserted;
END;
$$;

COMMENT ON FUNCTION pos_create_product(
  uuid, text, text, text, text, integer, integer, integer, boolean
) IS
  'The till''s only product write path. Inserts one product, validates money/stock/category, keeps the website flag false unless explicitly set, and is idempotent on p_id.';

REVOKE ALL ON FUNCTION pos_create_product(
  uuid, text, text, text, text, integer, integer, integer, boolean
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pos_create_product(
  uuid, text, text, text, text, integer, integer, integer, boolean
) TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- pos_record_return — foreign-key-safe optional references
-- ---------------------------------------------------------------------------
-- A return can reach the server before the sale or the product it refers to.
-- The till may have been offline when the sale synced, or the product may
-- never have been pushed. Inserting those ids blindly made the whole return
-- fail on a foreign key, losing the audit trail and the stock correction.
--
-- Resolve every optional id against the table it points at. An unknown id
-- becomes NULL; the durable name and the line details are still recorded.
-- This cannot restock a product the server has never seen, but it does record
-- that the return happened, which is the important half.
--
-- The quantity validation is still the table's `CHECK (quantity > 0)`. Stock
-- is aggregated per product inside the function so two lines for one product
-- add both quantities rather than letting one arbitrary line win an UPDATE.
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
  v_original_sale_id uuid;
  v_cashier_id uuid;
  v_manager_id uuid;
BEGIN
  IF p_client_uuid IS NULL THEN
    RAISE EXCEPTION 'A return must carry the client_uuid it was given at the till'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'A return must carry at least one line item'
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
    manager_id, manager_name, created_at
  )
  VALUES (
    p_client_uuid, v_original_sale_id, v_cashier_id, p_cashier_name,
    v_manager_id, p_manager_name, now()
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
  uuid, uuid, uuid, text, uuid, text, jsonb
) IS
  'The till''s only return write path. Records a return and its lines, restocks known products, treats unknown optional ids as NULL, and is idempotent on p_client_uuid.';

REVOKE ALL ON FUNCTION pos_record_return(
  uuid, uuid, uuid, text, uuid, text, jsonb
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pos_record_return(
  uuid, uuid, uuid, text, uuid, text, jsonb
) TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- Direct writes to the return tables are not the boundary
-- ---------------------------------------------------------------------------
-- 017 had to grant INSERT on both tables so the function could be written
-- against them, but the anon key could reach them directly. The function is
-- SECURITY DEFINER and owns the whole transaction; the tables themselves
-- should not be a public write path.
DROP POLICY IF EXISTS "The till can record a return" ON pos_returns;
DROP POLICY IF EXISTS "The till can record return items" ON pos_return_items;

REVOKE INSERT ON pos_returns, pos_return_items FROM anon, authenticated;
