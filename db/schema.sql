-- Reel2AICart L3 Index layer (PRD §6). Run once on Neon.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS video_embeddings (
  id TEXT PRIMARY KEY,
  video_hash TEXT UNIQUE NOT NULL,
  embedding vector(1024),
  summary JSONB NOT NULL,
  pdp_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS video_embeddings_hnsw
  ON video_embeddings USING hnsw (embedding vector_cosine_ops);

-- Write-once read-heavy cache replaces Redis (PRD §9). Hot reads via Vercel Edge.
CREATE TABLE IF NOT EXISTS video_cache (
  video_id TEXT PRIMARY KEY,
  summary JSONB NOT NULL
);

-- OAuth shop tokens (one row per installed shop). Written by /auth/callback,
-- read by Modal to resolve product media. Never exposed to the client.
CREATE TABLE IF NOT EXISTS shops (
  shop TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '',
  installed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Webhook delivery log. Every inbound event gets a row (received →
-- forwarded/failed + reason), rendered on the home dashboard so failures
-- are visible without digging through function logs.
CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGSERIAL PRIMARY KEY,
  shop TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  product_id BIGINT,
  status TEXT NOT NULL DEFAULT 'received',
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS webhook_events_recent
  ON webhook_events (created_at DESC);

-- Order attribution (PRD Pain 5). One row per video-attributed order,
-- written by webhooks.orders from note_attributes._shopify_video.
CREATE TABLE IF NOT EXISTS order_attribution (
  order_id BIGINT PRIMARY KEY,
  shop TEXT NOT NULL DEFAULT '',
  video_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- HITL frozen copies: verified rows are never overwritten by scans or
-- webhooks without an explicit per-row Release (see docs/SCAN_AND_ACTIVATION.md).
ALTER TABLE video_embeddings ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Scan jobs: full history (queued|running|done|failed), cursor-resumed.
CREATE TABLE IF NOT EXISTS scan_jobs (
  id BIGSERIAL PRIMARY KEY,
  shop TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  cursor TEXT NOT NULL DEFAULT '',
  scanned INT NOT NULL DEFAULT 0,
  enqueued INT NOT NULL DEFAULT 0,
  skipped_verified INT NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Readiness history: one row per activation check (latest = current state).
CREATE TABLE IF NOT EXISTS shop_status_checks (
  id BIGSERIAL PRIMARY KEY,
  shop TEXT NOT NULL DEFAULT '',
  checked_at TIMESTAMPTZ DEFAULT NOW(),
  token_ok BOOLEAN NOT NULL DEFAULT FALSE,
  missing_scopes TEXT NOT NULL DEFAULT '',
  mcp TEXT NOT NULL DEFAULT 'error',
  rows INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS shop_status_checks_recent
  ON shop_status_checks (shop, checked_at DESC);

-- Tagging history: our own record of tag attempts (layer 1 of tag
-- visibility; survives token expiry and shows failures too).
CREATE TABLE IF NOT EXISTS tag_events (
  id BIGSERIAL PRIMARY KEY,
  shop TEXT NOT NULL DEFAULT '',
  media_id TEXT NOT NULL DEFAULT '',
  variant_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'ok',
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tag_events_media
  ON tag_events (media_id, created_at DESC);

-- Ingest job tracking (Vercel -> Modal handoff outcomes). One row per
-- forwarded payload (webhook or scan); Modal reports back via
-- /api/ingest-callback on enriched/skipped/failed. Vercel never guesses.
CREATE TABLE IF NOT EXISTS ingest_jobs (
  id BIGSERIAL PRIMARY KEY,
  job_key TEXT UNIQUE NOT NULL,
  shop TEXT NOT NULL DEFAULT '',
  product_id BIGINT,
  source TEXT NOT NULL DEFAULT 'webhook',
  status TEXT NOT NULL DEFAULT 'sent',
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ingest_jobs_recent ON ingest_jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS ingest_jobs_shop ON ingest_jobs (shop, created_at DESC);

-- Generated-image audit/history (connect Pick-a-product, Muse Image 1.0).
-- One row per generation: shop + product + style, newest-first via the
-- lookup index; generating/keeping never mutates Shopify catalog data.
CREATE TABLE IF NOT EXISTS generated_images (
  id SERIAL PRIMARY KEY,
  shop TEXT NOT NULL,
  product_id TEXT NOT NULL,
  variant_id TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL CHECK (style IN ('flat-lay','folded-stack','single-stack','ghost-mannequin','hanger','on-actor')),
  prompt_version TEXT NOT NULL DEFAULT 'v1',
  source_mode TEXT NOT NULL CHECK (source_mode IN ('with-image','text-only')),
  provider TEXT NOT NULL DEFAULT 'muse-image-1.0',
  output_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_generated_images_lookup
  ON generated_images (shop, product_id, style, created_at DESC);
