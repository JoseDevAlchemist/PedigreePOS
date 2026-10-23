-- ===========================================================================
-- 018_pos_rotate_demo_manager_pin.sql
-- ===========================================================================
--
-- Replaces the seeded demo manager's PIN hash with a real bcrypt hash for a
-- PIN that is not `9999`.
--
-- Why: the app used to ship two hard-coded `9999` bypasses. Removing them is
-- only half the fix while the demo manager's hash still matches `9999`, because
-- then `9999` remains a working manager credential. This migration rotates the
-- seeded Grace Wanjiru row (fixed id from `pos_seed.sql`) to the documented
-- demo PIN `4826`.
--
-- This is a *demo* credential, not a production secret. Change it before the
-- till handles real money:
--
--   node -e "console.log(require('bcryptjs').hashSync('REPLACE_WITH_PIN', 10))"
--   UPDATE pos_users SET pin_hash = '<hash>' WHERE id = '...';
--
-- The name check catches a demo row that was created by hand instead of by
-- `pos_seed.sql`. If this project has a real manager named Grace, change her
-- PIN immediately after applying this file.
--
-- Safe to re-run: it sets the same hash for the same demo row and does nothing
-- if that row does not exist.
-- ===========================================================================

UPDATE pos_users
SET pin_hash = '$2b$10$R0ovDPF9brBujL97lLrUdeTmCrk4CE/yjd/wQBU86rnODsudNYFEq'
WHERE id = 'a1c9f1e2-0000-4000-8000-000000000002'
   OR (name = 'Grace Wanjiru' AND role = 'manager');
