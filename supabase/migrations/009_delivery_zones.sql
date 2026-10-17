-- ===========================================================================
-- 009_delivery_zones.sql — delivery zones for variable shipping fees
-- ===========================================================================
-- Run this in the Supabase SQL Editor, or with the Supabase CLI:
--   supabase db push                      (from a linked project)
--   supabase migration up                 (local dev stack)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS delivery_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  fee integer NOT NULL CHECK (fee >= 0),
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

INSERT INTO delivery_zones (name, fee, sort_order) VALUES
  ('Nairobi CBD', 250, 1),
  ('Westlands / Parklands', 300, 2),
  ('Karen / Langata', 400, 3),
  ('Outside Nairobi', 600, 4)
ON CONFLICT DO NOTHING;

-- Add zone_id and zone_name to orders
ALTER TABLE orders ADD COLUMN IF NOT EXISTS zone_id uuid REFERENCES delivery_zones(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS zone_name text;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE delivery_zones ENABLE ROW LEVEL SECURITY;

-- Public can read active zones (for checkout)
DROP POLICY IF EXISTS "Public read active delivery_zones" ON delivery_zones;
CREATE POLICY "Public read active delivery_zones"
  ON delivery_zones FOR SELECT TO anon, authenticated
  USING (active = true);

-- Authenticated admins have full access
DROP POLICY IF EXISTS "Admins full access delivery_zones" ON delivery_zones;
CREATE POLICY "Admins full access delivery_zones"
  ON delivery_zones FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);