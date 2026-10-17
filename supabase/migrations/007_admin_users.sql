-- ===========================================================================
-- 005_admin_users.sql — admin users and roles
-- ===========================================================================
-- Run this in the Supabase SQL Editor, or with the Supabase CLI:
--   supabase db push                      (from a linked project)
--   supabase migration up                 (local dev stack)
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- admin_users table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('owner', 'worker')),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Seed with the owner
-- ---------------------------------------------------------------------------
INSERT INTO admin_users (email, role, display_name)
VALUES ('josephkaruga183@gmail.com', 'owner', 'Owner')
ON CONFLICT (email) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

-- Only authenticated can read
DROP POLICY IF EXISTS "Authenticated read admin_users" ON admin_users;
CREATE POLICY "Authenticated read admin_users"
  ON admin_users FOR SELECT TO authenticated USING (true);

-- Only owners can insert/update/delete
DROP POLICY IF EXISTS "Owners insert admin_users" ON admin_users;
CREATE POLICY "Owners insert admin_users"
  ON admin_users FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admin_users au
      WHERE au.email = (auth.jwt() ->> 'email')
      AND au.role = 'owner'
    )
  );

DROP POLICY IF EXISTS "Owners update admin_users" ON admin_users;
CREATE POLICY "Owners update admin_users"
  ON admin_users FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admin_users au
      WHERE au.email = (auth.jwt() ->> 'email')
      AND au.role = 'owner'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admin_users au
      WHERE au.email = (auth.jwt() ->> 'email')
      AND au.role = 'owner'
    )
  );

DROP POLICY IF EXISTS "Owners delete admin_users" ON admin_users;
CREATE POLICY "Owners delete admin_users"
  ON admin_users FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admin_users au
      WHERE au.email = (auth.jwt() ->> 'email')
      AND au.role = 'owner'
    )
    AND email != (auth.jwt() ->> 'email')
    AND NOT (
      SELECT count(*) FROM admin_users WHERE role = 'owner'
    ) <= 1
  );