-- T1 (refs #4): generated_images audit/history table for optional
-- Muse Image 1.0 generation in the connect Pick-a-product flow.
-- Neon-SQL-editor safe: plain SQL only, NO psql backslash commands.
-- Idempotent: safe to re-run on a database that already has the table.
-- Fresh setups get the same statements via db/schema.sql.
CREATE TABLE IF NOT EXISTS generated_images (
  id SERIAL PRIMARY KEY,
  shop TEXT NOT NULL,
  product_id TEXT NOT NULL,
  variant_id TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL CHECK (style IN ('flat-lay','folded-stack','single-folded','ghost-mannequin','hanger','on-actor')),
  prompt_version TEXT NOT NULL DEFAULT 'v1',
  source_mode TEXT NOT NULL CHECK (source_mode IN ('with-image','text-only')),
  provider TEXT NOT NULL DEFAULT 'muse-image-1.0',
  output_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_generated_images_lookup
  ON generated_images (shop, product_id, style, created_at DESC);
