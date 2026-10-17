-- ===========================================================================
-- 015_pos_card_payments.sql — "card" becomes a third way to be paid
-- ===========================================================================
--
-- Run after 014_pos_record_sale.sql, in the same shared project.
--
-- ---------------------------------------------------------------------------
-- Why this is a migration and not a code change
-- ---------------------------------------------------------------------------
-- 012 put a CHECK on `pos_sales.payment_method` that allowed exactly two
-- values, `cash` and `mpesa`. A card sale is a *fact* the till already has —
-- the slip is in the cashier's hand — so the server refusing the row is not a
-- guardrail, it is the till losing money it has taken. Widening the allowed set
-- is the whole change; `pos_record_sale` needs no edit, because it already
-- passes the method through without inspecting it.
--
-- ---------------------------------------------------------------------------
-- Where the reference goes
-- ---------------------------------------------------------------------------
-- A card sale carries the terminal's slip reference, in the same free-text
-- column M-Pesa uses, `mpesa_code`. The column name is now the only M-Pesa
-- thing about it; renaming it would break migrations 012 and 014, which are
-- documented as safe to run twice and still refer to `mpesa_code`. A comment
-- on the column is enough to stop it being misread.
--
-- The rule is unchanged in spirit: cash carries no code, and a method that has
-- a code carries no tendered/change. `card` joins `mpesa` on the second branch.
--
-- Idempotent: the constraints are dropped and recreated, so re-running is safe.
-- ===========================================================================

ALTER TABLE pos_sales
  DROP CONSTRAINT IF EXISTS pos_sales_payment_method_check;

ALTER TABLE pos_sales
  ADD CONSTRAINT pos_sales_payment_method_check
  CHECK (payment_method IN ('cash', 'mpesa', 'card'));

ALTER TABLE pos_sales
  DROP CONSTRAINT IF EXISTS pos_sales_payment_details;

ALTER TABLE pos_sales
  ADD CONSTRAINT pos_sales_payment_details CHECK (
    (payment_method = 'cash' AND mpesa_code IS NULL)
    OR
    (payment_method IN ('mpesa', 'card')
      AND amount_tendered IS NULL AND change_due IS NULL)
  );

COMMENT ON COLUMN pos_sales.mpesa_code IS
  'M-Pesa confirmation code (mpesa) or card terminal slip reference (card). Free text; NULL for cash.';
