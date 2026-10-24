-- ===========================================================================
-- phase1_server_boundaries.sql — RLS checks for the Phase 1 write boundaries
-- ===========================================================================
--
-- Run against a local Supabase database:
--
--   pnpm test:rls
--
-- The test runs in one transaction and rolls back, so it leaves no rows
-- behind. Fixture rows are created as the migration owner before the role
-- switch. That gives the direct table inserts valid foreign keys, so a
-- foreign-key error cannot mask a policy failure.
--
-- What it proves:
--   1. anon cannot INSERT a product directly;
--   2. anon can call pos_create_product;
--   3. anon cannot INSERT a return directly;
--   4. anon cannot INSERT a return line directly;
--   5. anon can call pos_record_return with unknown references;
--   6. a return against a known sale/product restocks exactly one unit;
--   7. replaying that return is a no-op;
--   8. a return beyond the sale's remaining units is rejected;
--   9. the replay and rejection did not change the stock again;
--  10. the refund amount and method were stored.
-- ===========================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

-- Fixtures for the stock and over-return checks. Created as the migration
-- owner, outside the anon role, and removed by ROLLBACK.
INSERT INTO products (id, name, slug, category, base_price, stock_quantity)
VALUES (
  '00000000-0000-4000-8000-000000000021',
  'RLS return product',
  'rls-return-product',
  'bag',
  100,
  0
);

INSERT INTO pos_sales (
  id, client_uuid, cashier_name, subtotal_kes, total_kes, payment_method
)
VALUES (
  '00000000-0000-4000-8000-000000000022',
  '00000000-0000-4000-8000-000000000023',
  'RLS test cashier',
  200,
  200,
  'cash'
);

INSERT INTO pos_sale_items (
  id, sale_id, product_id, product_name, quantity, price_at_sale
)
VALUES (
  '00000000-0000-4000-8000-000000000024',
  '00000000-0000-4000-8000-000000000022',
  '00000000-0000-4000-8000-000000000021',
  'RLS return product',
  2,
  100
);

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
      ),
      0,
      NULL,
      NULL
    )
  $$,
  'anon can record a return with unknown references through pos_record_return'
);

-- 6. A return against the fixture sale succeeds and records a refund.
SELECT is(
  (
    SELECT pos_record_return(
      '00000000-0000-4000-8000-000000000030',
      '00000000-0000-4000-8000-000000000022',
      NULL,
      'RLS test cashier',
      NULL,
      'RLS test manager',
      jsonb_build_array(
        jsonb_build_object(
          'product_id', '00000000-0000-4000-8000-000000000021',
          'product_name', 'RLS return product',
          'quantity', 1
        )
      ),
      100,
      'cash',
      'REF-1'
    )
  ),
  true,
  'anon can return one unit of a known sale'
);

-- 7. A replayed push is free. The same client_uuid must return false and must
-- not restock the product again.
SELECT is(
  (
    SELECT pos_record_return(
      '00000000-0000-4000-8000-000000000030',
      '00000000-0000-4000-8000-000000000022',
      NULL,
      'RLS test cashier',
      NULL,
      'RLS test manager',
      jsonb_build_array(
        jsonb_build_object(
          'product_id', '00000000-0000-4000-8000-000000000021',
          'product_name', 'RLS return product',
          'quantity', 1
        )
      ),
      100,
      'cash',
      'REF-1'
    )
  ),
  false,
  'a replayed return is a no-op'
);

-- 8. The sale sold two units and one has been returned. Asking for the other
-- two must be rejected rather than over-returning and inflating stock.
SELECT throws_ok(
  $$
    SELECT pos_record_return(
      '00000000-0000-4000-8000-000000000031',
      '00000000-0000-4000-8000-000000000022',
      NULL,
      'RLS test cashier',
      NULL,
      'RLS test manager',
      jsonb_build_array(
        jsonb_build_object(
          'product_id', '00000000-0000-4000-8000-000000000021',
          'product_name', 'RLS return product',
          'quantity', 2
        )
      ),
      0,
      NULL,
      NULL
    )
  $$,
  23514,
  NULL,
  'a return beyond the remaining sold quantity is rejected'
);

-- 9. Starting stock was zero; the first return added one, the replay and the
-- rejected over-return added nothing.
SELECT results_eq(
  $$
    SELECT stock_quantity
    FROM products
    WHERE id = '00000000-0000-4000-8000-000000000021'
  $$,
  ARRAY[1],
  'the successful return restocked exactly one unit'
);

-- 10. Refund fields are durable. Switch back to the owner to read the row;
-- anon has no SELECT policy on pos_returns.
RESET ROLE;
SET LOCAL search_path = public, extensions;

SELECT results_eq(
  $$
    SELECT refund_kes, refund_method, refund_reference
    FROM pos_returns
    WHERE client_uuid = '00000000-0000-4000-8000-000000000030'
  $$,
  $$ VALUES (100, 'cash'::text, 'REF-1'::text) $$,
  'the return stores its refund amount, method and reference'
);

SELECT * FROM finish();

ROLLBACK;
