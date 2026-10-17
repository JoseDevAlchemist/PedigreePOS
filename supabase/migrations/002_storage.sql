-- ===========================================================================
-- 002_storage.sql — the product-images bucket
-- ===========================================================================
--
-- Run after 001_initial.sql. Same instructions: SQL Editor, or `supabase db push`.
-- Idempotent throughout.
--
-- ---------------------------------------------------------------------------
-- Why a public bucket
-- ===========================================================================
-- Product photography is marketing material. It is served directly by Supabase's
-- CDN in front of the shop, and the same URL appears in the HTML that search
-- engines and social cards read. Every URL is derived from the angle and colour
-- name, so they are guessable — which is fine, because these are pictures of a
-- handbag and the alternative is signing every image request.
--
-- The consequence, stated plainly: **anything uploaded here is public.** Do not
-- put anything in this bucket that is not product photography. If drafts or
-- private reference shots are ever needed, that is a second bucket with
-- `public = false` and signed URLs — see docs/ADMIN_INTEGRATION_TODO.md.
-- ===========================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  true,
  -- 8 MB. A product photograph is 1–3 MB; anything much larger is a phone camera
  -- original that has not been resized, and letting those in would blow the
  -- bucket's free tier on twelve products.
  8388608,
  -- Images only. A bucket that accepts arbitrary types is a bucket someone will
  -- eventually upload an HTML file into.
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
ON CONFLICT (id) DO NOTHING;


-- ===========================================================================
-- Storage policies
--
-- storage.objects is subject to RLS, so the bucket being public does not by
-- itself grant read: these policies are what actually decide.
-- ===========================================================================

-- Public read. Redundant for a `public = true` bucket, and kept deliberately:
-- it documents the intent, and it keeps the read rule true if the bucket is ever
-- flipped to private by accident, in which case the shop keeps working and the
-- mistake is not a broken homepage.
DROP POLICY IF EXISTS "Public can read product images" ON storage.objects;
CREATE POLICY "Public can read product images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'product-images');

-- Uploads. TO authenticated is the whole authorisation: the admin's browser client
-- carries the user's JWT, so this is "a signed-in user may upload", enforced by
-- Postgres rather than by a check somewhere in the UI.
DROP POLICY IF EXISTS "Authenticated can upload product images" ON storage.objects;
CREATE POLICY "Authenticated can upload product images"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'product-images');

-- Update: the admin replaces a photo in place, keeping the same slot.
-- USING covers which existing rows may be overwritten, WITH CHECK covers the row
-- as it will afterwards. Both are needed; omitting WITH CHECK lets an update move
-- an object into another bucket.
DROP POLICY IF EXISTS "Authenticated can update product images" ON storage.objects;
CREATE POLICY "Authenticated can update product images"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'product-images')
  WITH CHECK (bucket_id = 'product-images');

DROP POLICY IF EXISTS "Authenticated can delete product images" ON storage.objects;
CREATE POLICY "Authenticated can delete product images"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'product-images');