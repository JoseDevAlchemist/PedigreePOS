-- ===========================================================================
-- phase1_server_boundaries.sql — RLS checks for the Phase 1 write boundaries
-- ===========================================================================
--
-- Run against a local Supabase database:
--
--   pnpm test:rls
--
-- The test runs in one transaction and rolls back, so it leaves no rows
-- behind. The fixture return row is created as the migration owner before the
-- role switch. That gives the direct `pos_return_items` insert a valid foreign
-- key, so a foreign-key error cannot mask a policy failure.
--
-- What it proves:
--   1. anon cannot INSERT a product directly;
--   2. anon can call pos_create_product;
--   3. anon cannot INSERT a return directly;
--   4. anon cannot INSERT a return line directly;
--   5. anon can call pos_record_return, including with unknown references.
-- ===========================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

-- Fixture for the direct pos_return_items insert. Created as the migration
-- owner, outside the anon role, and removed by ROLLBACK.
INSERT INTO pos_returns (id, client_uuid, cashier_name, manager_name)
VALUES (
  '00000000-0000-4000-8000-000000000019',
  '00000000-0000-4000-8000-000000000018',
  'RLS test cashier',
  'RLS test manager'
);

-- Everything below runs with exactly the privileges the till has.
SET LOCAL ROLE anon;
-- Keep `extensions` on the path: Supabase installs pgTAP there in the local
-- test runner, while the till's own tables and functions live in `public`.
SET LOCAL search_path = public, extensions;

-- 1. Direct product INSERT is not a till write path.
SELECT throws_ok(
  $$
    INSERT INTO products (id, name, slug, category, base_price)
    VALUES (
      '00000000-0000-4000-8000-000000000011',
      'RLS test direct product',
      'rls-test-direct-product',
      'bag',
      100
    )
  $$,
  42501,
  NULL,
  'anon cannot INSERT a product directly'
);

-- 2. The RPC is the product write path. A proper call succeeds.
SELECT lives_ok(
  $$
    SELECT pos_create_product(
      '00000000-0000-4000-8000-000000000012',
      'RLS test RPC product',
      'rls-test-rpc-product',
      'bag',
      NULL,
      100,
      0,
      0,
      false
    )
  $$,
  'anon can create a product through pos_create_product'
);

-- 3. Direct return INSERT is not the boundary.
SELECT throws_ok(
  $$
    INSERT INTO pos_returns (client_uuid, cashier_name, manager_name)
    VALUES (
      '00000000-0000-4000-8000-000000000013',
      'RLS test direct return',
      'RLS test direct return'
    )
  $$,
  42501,
  NULL,
  'anon cannot INSERT a return directly'
);

-- 4. Direct return-line INSERT is not the boundary. The return id exists
-- (fixture above), so this cannot pass because of a foreign-key error.
SELECT throws_ok(
  $$
    INSERT INTO pos_return_items (return_id, product_name, quantity)
    VALUES (
      '00000000-0000-4000-8000-000000000019',
      'RLS test direct return item',
      1
    )
  $$,
  42501,
  NULL,
  'anon cannot INSERT a return line directly'
);

-- 5. The return RPC is the boundary. Unknown sale/cashier/manager/product
-- ids must not make it fail: the audit names and line details are enough.
SELECT lives_ok(
  $$
    SELECT pos_record_return(
      '00000000-0000-4000-8000-000000000014',
      '00000000-0000-4000-8000-000000000015',
      '00000000-0000-4000-8000-000000000016',
      'RLS test cashier',
      '00000000-0000-4000-8000-000000000017',
      'RLS test manager',
      jsonb_build_array(
        jsonb_build_object(
          'product_id', '00000000-0000-4000-8000-00000000001a',
          'product_name', 'RLS test unknown product',
          'quantity', 1
        )
      )
    )
  $$,
  'anon can record a return with unknown references through pos_record_return'
);

SELECT * FROM finish();

ROLLBACK;
