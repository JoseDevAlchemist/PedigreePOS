-- ===========================================================================
-- 016_pos_staff_enrolment.sql — the manager can add a cashier from the till
-- ===========================================================================
--
-- Run after 015_pos_card_payments.sql, in the same shared project.
--
-- ---------------------------------------------------------------------------
-- The gap
-- ---------------------------------------------------------------------------
-- 012 gave `pos_users` a SELECT policy and deliberately no write policy, so
-- till staff were seeded with SQL. Phase 2 adds a Staff screen, and seeding a
-- person from an editor is not a staff-management feature.
--
-- ---------------------------------------------------------------------------
-- What this grants, and what it deliberately does not
-- ---------------------------------------------------------------------------
-- INSERT only, and only for rows that are `role = 'cashier'` and `active =
-- true`. That is narrower than it sounds: `WITH CHECK` is evaluated against
-- every inserted row, so this policy cannot mint a manager and cannot write a
-- deactivated one. There is still no UPDATE and no DELETE, so an existing
-- cashier cannot be promoted, re-pinned or removed through the app's key.
--
-- ---------------------------------------------------------------------------
-- The honest limitation
-- ---------------------------------------------------------------------------
-- The POS has no server session — people sign in with a PIN verified on the
-- device — so the database cannot tell a manager's browser from a cashier's.
-- Anyone holding the publishable key can therefore insert a cashier, and a
-- cashier who can edit `localStorage` can reach the staff screen. This is the
-- same Phase 1 boundary 012 documents for the role check: it stops honest
-- mistakes, not a determined person with the device. Real enforcement needs the
-- device-token enrolment described in 012's closing note.
--
-- Idempotent: drop then create.
-- ===========================================================================

DROP POLICY IF EXISTS "The manager can add till staff" ON pos_users;

CREATE POLICY "The manager can add till staff"
  ON pos_users FOR INSERT TO anon, authenticated
  WITH CHECK (role = 'cashier' AND active = true);
