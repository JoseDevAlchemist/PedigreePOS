-- ===========================================================================
-- pos_seed.sql — demo till staff
-- ===========================================================================
--
-- OPTIONAL. Not a migration: this inserts sample people, and sample people do
-- not belong in a schema change that runs on every environment.
--
-- Run once in the Supabase SQL Editor after 014_pos_record_sale.sql. Safe to
-- run twice — the rows carry fixed ids and `ON CONFLICT DO NOTHING`.
--
-- Existing installs with the old demo row should run
-- 018_pos_rotate_demo_manager_pin.sql as well; the ON CONFLICT above will not
-- update a PIN that is already present.
--
--   name            role      PIN
--   Brian Otieno    cashier   1234
--   Grace Wanjiru   manager   4826
--
-- The PINs above are the only place they exist in plain text, and they exist
-- here only so a developer can sign in. These are throwaway demo credentials:
-- change them before the till sees real money.
--
-- To add or change a PIN, never hand-write a hash. Generate one with the app's
-- own bcrypt settings and paste the result:
--
--   node -e "console.log(require('bcryptjs').hashSync('4321', 10))"
--
-- then:
--
--   UPDATE pos_users SET pin_hash = '<the $2b$... string>' WHERE name = 'Brian Otieno';
--
-- PINs must be unique across active staff: sign-in is a bare PIN with no user
-- picker, so the first matching hash wins (see lib/auth.ts).
-- ===========================================================================


INSERT INTO pos_users (id, name, pin_hash, role)
VALUES
  (
    'a1c9f1e2-0000-4000-8000-000000000001',
    'Brian Otieno',
    '$2b$10$Raiee28ncUq4J5ComgyiOeuUnl24wqUbA3A13RtCtNi03N3b26C.a',
    'cashier'
  ),
  (
    'a1c9f1e2-0000-4000-8000-000000000002',
    'Grace Wanjiru',
    '$2b$10$R0ovDPF9brBujL97lLrUdeTmCrk4CE/yjd/wQBU86rnODsudNYFEq',
    'manager'
  )
ON CONFLICT (id) DO NOTHING;
