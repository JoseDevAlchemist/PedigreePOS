-- 022_pos_anon_settings_writes.sql
--
-- The offline POS has no Supabase Auth session: cashiers sign in with a PIN
-- verified on the device, and the browser client runs under the anon key. The
-- manager settings screen therefore writes shop_settings and pos_discounts with
-- that anon key. The UI is gated by RequireAuth role="manager"; this migration
-- grants the database side of that Phase 1 tradeoff.

-- Exchange rate: anon may update the single default settings row only.
DROP POLICY IF EXISTS "Admins update shop_settings" ON shop_settings;
DROP POLICY IF EXISTS "POS update shop_settings" ON shop_settings;
CREATE POLICY "POS update shop_settings"
  ON shop_settings FOR UPDATE TO anon, authenticated
  USING (id = 'default')
  WITH CHECK (id = 'default');

GRANT UPDATE ON shop_settings TO anon, authenticated;

-- Discounts: anon may read, insert and update codes; deletes stay admin-only.
DROP POLICY IF EXISTS "Admins write pos_discounts" ON pos_discounts;
DROP POLICY IF EXISTS "POS insert pos_discounts" ON pos_discounts;
DROP POLICY IF EXISTS "POS update pos_discounts" ON pos_discounts;
CREATE POLICY "POS insert pos_discounts"
  ON pos_discounts FOR INSERT TO anon, authenticated
  WITH CHECK (true);
CREATE POLICY "POS update pos_discounts"
  ON pos_discounts FOR UPDATE TO anon, authenticated
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON pos_discounts TO anon, authenticated;
