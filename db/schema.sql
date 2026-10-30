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
