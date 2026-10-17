-- ===========================================================================
-- 010_usd_pricing.sql — add optional USD price to products
-- ===========================================================================
-- Run this in the Supabase SQL Editor, or with the Supabase CLI:
--   supabase db push                      (from a linked project)
--   supabase migration up                 (local dev stack)
-- ===========================================================================

-- USD price is optional. When NULL, only KES is shown.
-- When set, both currencies are shown on the card and detail page.
-- Discounts apply proportionally to both prices.

ALTER TABLE products ADD COLUMN IF NOT EXISTS base_price_usd integer;

-- Sanity constraint: if set, must be positive.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_usd_price_positive;
ALTER TABLE products ADD CONSTRAINT products_usd_price_positive
  CHECK (base_price_usd IS NULL OR base_price_usd > 0);