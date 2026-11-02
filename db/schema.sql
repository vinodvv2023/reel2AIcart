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
