-- 021_pos_settings_discounts_adjustments.sql
ALTER TABLE shop_settings
  ADD COLUMN IF NOT EXISTS exchange_rate_kes_to_usd numeric NOT NULL DEFAULT 130;

CREATE TABLE IF NOT EXISTS pos_discounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  percentage integer NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pos_discounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read pos_discounts" ON pos_discounts;
CREATE POLICY "Public read pos_discounts"
  ON pos_discounts FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Admins write pos_discounts" ON pos_discounts;
CREATE POLICY "Admins write pos_discounts"
  ON pos_discounts FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Stock adjustment RPC
CREATE OR REPLACE FUNCTION pos_adjust_stock(p_product_id uuid, p_delta integer, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE products SET stock_quantity = GREATEST(0, stock_quantity + p_delta)
  WHERE id = p_product_id;
END;
$$;
