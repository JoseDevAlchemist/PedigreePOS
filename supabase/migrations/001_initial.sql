-- ===========================================================================
-- 001_initial.sql — the shop's product catalogue
-- ===========================================================================
--
-- Run this in the Supabase SQL Editor, or with the Supabase CLI:
--
--   supabase db push                      (from a linked project)
--   supabase migration up                 (local dev stack)
--
-- SQL Editor: Dashboard -> SQL Editor -> New query -> paste this whole file ->
-- Run. It is safe to run twice; every statement is guarded.
--
-- ---------------------------------------------------------------------------
-- The shape, and why
-- ---------------------------------------------------------------------------
-- Three tables, not one wide table. The awkward part of this domain is that a
-- product has colours and each colour has images, and the *number of angles*
-- differs by category: a bag has five views, a shoe has a different five. A
-- `images jsonb` column would have been less code and would have made "show me
-- every bag missing its back view" unanswerable — which is the query an admin
-- needs most, because the whole admin exists to fix that.
--
-- So: rows. One row per image slot, whether or not it has a photo yet.
--
-- Note there is no `angles` column. The angles a product *has* are derived from
-- its category rather than stored:
--
--   bag  -> front, side-left, side-right, top, back
--   shoe -> front, laces, side, back, bottom
--
-- Storing them would mean every product row carries a list that has to be kept
-- in step with the category, and nothing could ever be added to the shoot list
-- without a migration. A category with an unusual set of views is the one case
-- this does not cover, and it is not worth a join table to handle.
--
-- ---------------------------------------------------------------------------
-- Money
-- ---------------------------------------------------------------------------
-- `base_price` is whole shillings in an integer. Kenya has no practice of
-- quoting cents on leather goods, and fractional shillings would mean every
-- percentage discount produces a figure the UI cannot render. An integer also
-- removes the floating-point rounding bugs that `numeric` would invite, because
-- the only arithmetic is `base_price * (100 - discount_percent) / 100`.
--
-- ---------------------------------------------------------------------------
-- `active` versus `discount_percent = 0`
-- ---------------------------------------------------------------------------
-- `active` is the on/off switch; a discount is a price. Keeping them apart means
-- "we are sold out" and "we are not selling this today" are different facts with
-- different consequences: a zero discount is still browsable, and `active = false`
-- disappears from the shop entirely while staying visible in the admin.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- products
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  name text NOT NULL,
  -- URL segment: /bags/karura-tote. Immutable once created: changing it breaks
  -- every link to the product, and the admin treats it as read-only after save.
  slug text NOT NULL UNIQUE,

  description text NOT NULL DEFAULT '',

  category text NOT NULL CHECK (category IN ('bag', 'shoe')),

  base_price integer NOT NULL CHECK (base_price >= 0),
  discount_percent integer NOT NULL DEFAULT 0
    CHECK (discount_percent >= 0 AND discount_percent <= 100),
  stock_quantity integer NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),

  -- Manual merchandising. Never derived, never rotated by a job. See the note in
  -- app/page.tsx: freshness comes from new stock, not from rotation.
  featured boolean NOT NULL DEFAULT false,

  -- The on/off switch. False hides the product from the shop entirely while
  -- keeping it in the admin.
  active boolean NOT NULL DEFAULT true,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- product_colors — one row per colourway
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_colors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CASCADE is the point: deleting a product takes its colours with it, and the
  -- images with them. Without it a deleted product would leave orphan rows that
  -- no policy can read and no admin page lists.
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,

  color_name text NOT NULL,
  -- Swatch and placeholder fill, e.g. '#8B4513'. Kept as text because it is
  -- written straight into a CSS colour and validated as a hex string, not
  -- computed on. A colour space type here would be ceremony.
  color_hex text NOT NULL,

  -- Display order. The shop shows colours in the order a person chose them, and
  -- "first colour is the default" is a real product decision, not an accident of
  -- insertion order.
  sort_order integer NOT NULL DEFAULT 0,

  -- One row per colourway per product. This is a domain invariant, not a
  -- convenience: two rows for "Black" on one product is a bug that shows up as a
  -- duplicated swatch in the shop and as two independent image sets in the admin.
  -- It is also what makes the seed idempotent, since `ON CONFLICT (product_id,
  -- color_name) DO NOTHING` needs a constraint to conflict on.
  UNIQUE (product_id, color_name)
);

-- ---------------------------------------------------------------------------
-- product_images — one row per (colour, angle) slot, photo or not
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  color_id uuid NOT NULL REFERENCES product_colors(id) ON DELETE CASCADE,

  -- The eight-angle union from lib/types.ts. A CHECK rather than an enum type:
  -- adding an angle is then a one-line migration instead of ALTER TYPE, which
  -- cannot run inside a transaction on some Postgres versions.
  angle text NOT NULL CHECK (
    angle IN ('front', 'side-left', 'side-right', 'side', 'top', 'bottom', 'back', 'laces')
  ),

  -- Null means "this view has not been photographed yet", which is every slot
  -- today. The UI renders a block of the colour's own hex in that case, so a
  -- product with no photography at all is still browsable.
  image_url text,

  sort_order integer NOT NULL DEFAULT 0,

  -- Exactly one photograph per view per colourway. This is what lets the admin's
  -- upload path be an upsert rather than an insert-then-delete dance, and it is
  -- what stops a double-click on "upload" leaving two rows for one slot where the
  -- read path would silently show only the first.
  UNIQUE (color_id, angle)
);


-- ---------------------------------------------------------------------------
-- Indexes
--
-- Each one answers a query the app actually makes. `slug` already has a unique
-- index from its UNIQUE constraint; this one is so a case-insensitive slug
-- collision check does not scan the table.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_products_slug        ON products(slug);
CREATE INDEX IF NOT EXISTS idx_products_category    ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_active      ON products(active);
CREATE INDEX IF NOT EXISTS idx_colors_product       ON product_colors(product_id);
CREATE INDEX IF NOT EXISTS idx_images_color         ON product_images(color_id);

-- The admin's default listing is "newest first, everything", and the shop's is
-- "active, newest first". A descending index on created_at serves the first, and
-- the composite one serves the second with no sort step.
CREATE INDEX IF NOT EXISTS idx_products_created_at  ON products(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_active_created ON products(active, created_at DESC);

-- Reading a product means reading its colours and their images in one round trip,
-- which is the single most common query in the app. Without a covering order this
-- is a filesort on every grid render.
CREATE INDEX IF NOT EXISTS idx_images_color_angle ON product_images(color_id, angle);


-- ---------------------------------------------------------------------------
-- There is no `angles` column, and the read path asks for the category's angles
-- and overlays whatever image rows exist — a slot with no row is a slot with no
-- photograph. That decision lives in exactly one place, `categoryAngles` in
-- lib/angles.ts, so there is no column here that can fall out of step with it.
--
-- The cost of this shape: reading a product is three joins rather than one row,
-- and a grid of twelve products fans out to roughly forty colour rows. At that
-- size Postgres does not notice, and the shop's public reads are cacheable by
-- slug. The day it hurts is the day the catalogue passes a few thousand products,
-- and the answer then is a view or a denormalised JSON column — not a schema
-- designed in advance for a size this shop has not reached.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- Row Level Security
-- ===========================================================================
--
-- Everything below is enabled with no policy for the service role, which is the
-- important part: `authenticated` does NOT include `service_role`. The service
-- role bypasses RLS by owning the table's bypass attribute, and no policy is
-- needed for it. That is why the admin works through lib/supabase/admin.ts while
-- the shop works through RLS, and why an admin table does not need its own policy
-- set.
-- ===========================================================================

ALTER TABLE products       ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_colors ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Public read
--
-- Three policies rather than one, because the nesting differs: an image is only
-- readable if its colour is readable AND that colour's product is active. Getting
-- this wrong is how a draft product's photography leaks through a guessable URL,
-- so the chain is spelled out rather than assumed.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public can read active products" ON products;
CREATE POLICY "Public can read active products"
  ON products FOR SELECT
  USING (active = true);

DROP POLICY IF EXISTS "Public can read colors of active products" ON product_colors;
CREATE POLICY "Public can read colors of active products"
  ON product_colors FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM products p WHERE p.id = product_id AND p.active = true)
  );

DROP POLICY IF EXISTS "Public can read images of active products" ON product_images;
CREATE POLICY "Public can read images of active products"
  ON product_images FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM product_colors pc
      JOIN products p ON p.id = pc.product_id
      WHERE pc.id = color_id AND p.active = true
    )
  );

-- ---------------------------------------------------------------------------
-- Authenticated write
--
-- `FOR ALL` with USING(true) covers SELECT/UPDATE/DELETE; WITH CHECK(true) covers
-- INSERT and, importantly, UPDATE — without it Postgres would validate the *new*
-- row against a policy and silently drop any update on a row the USING clause
-- excluded. `USING(true)` makes every row visible to every signed-in user.
--
-- This is deliberately coarse. There are no staff roles in this project yet, so
-- every authenticated user is an admin, and the policy says exactly that. When
-- roles arrive, this is the block to narrow — see
-- docs/ADMIN_INTEGRATION_TODO.md, which is where it is written down.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated full access products" ON products;
CREATE POLICY "Authenticated full access products"
  ON products FOR ALL
  TO authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated full access colors" ON product_colors;
CREATE POLICY "Authenticated full access colors"
  ON product_colors FOR ALL
  TO authenticated
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Authenticated full access images" ON product_images;
CREATE POLICY "Authenticated full access images"
  ON product_images FOR ALL
  TO authenticated
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
-- Deliberately not enabled. Nothing subscribes: the admin does not poll or listen,
-- it refreshes after each write, because the person doing the writing is the person
-- who needs to see the result and they are already looking at it. Live updates
-- would be one `ALTER PUBLICATION` away when there is a second person in the room,
-- which is a job two people doing. See docs/ADMIN_INTEGRATION_TODO.md.
-- ===========================================================================