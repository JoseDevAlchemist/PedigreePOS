-- ===========================================================================
-- 008_shop_settings.sql — shop configuration settings
-- ===========================================================================
-- Run this in the Supabase SQL Editor, or with the Supabase CLI:
--   supabase db push                      (from a linked project)
--   supabase migration up                 (local dev stack)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS shop_settings (
  id text PRIMARY KEY DEFAULT 'default',
  shop_name text NOT NULL DEFAULT 'Pedigree Leather',
  phone text NOT NULL DEFAULT '+254 791 004 004',
  whatsapp text NOT NULL DEFAULT '254791004004',
  email text,
  address text NOT NULL DEFAULT 'Rosslyn Luxury Mall, Annex 2, Shop RLM 48, Nairobi, Kenya',
  google_maps_url text,
  delivery_flat_rate integer NOT NULL DEFAULT 300,
  free_delivery_threshold integer NOT NULL DEFAULT 25000,
  pickup_available boolean NOT NULL DEFAULT true,
  updated_at timestamptz DEFAULT now()
);

INSERT INTO shop_settings (id) VALUES ('default') ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE shop_settings ENABLE ROW LEVEL SECURITY;

-- Public can read (for customer-facing pages)
DROP POLICY IF EXISTS "Public read shop_settings" ON shop_settings;
CREATE POLICY "Public read shop_settings"
  ON shop_settings FOR SELECT TO anon, authenticated
  USING (true);

-- Authenticated admins can update
DROP POLICY IF EXISTS "Admins update shop_settings" ON shop_settings;
CREATE POLICY "Admins update shop_settings"
  ON shop_settings FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (true);