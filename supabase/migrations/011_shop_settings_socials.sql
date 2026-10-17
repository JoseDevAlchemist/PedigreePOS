-- ===========================================================================
-- 011_shop_settings_socials.sql — add Instagram handle and URL to shop settings
-- ===========================================================================
-- Run this in the Supabase SQL Editor, or with the Supabase CLI:
--   supabase db push                      (from a linked project)
--   supabase migration up                 (local dev stack)
-- ===========================================================================

ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS instagram_handle text;
ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS instagram_url text;

-- Seed with placeholder values
UPDATE shop_settings
SET instagram_handle = '@pedigreeleather',
    instagram_url = 'https://instagram.com/pedigreeleather'
WHERE id = 'default' AND instagram_handle IS NULL;