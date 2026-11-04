-- Full per-shop cleanup (full catalog replacement).
-- Run in the Neon SQL editor. video_embeddings / video_cache have NO shop
-- column, so item rows are matched via pdp_url (enrichment always writes
-- pdp_url = https://{shop}/products/...). The shops row (OAuth token) is
-- KEPT so the store does NOT need reinstalling — delete it only if you also
-- want to force a fresh OAuth install.
--
-- 1. Set the shop below. 2. Run the PREVIEW block, check counts.
-- 3. Only then run the DELETE transaction.

\set shop 'reel2aicart-test.myshopify.com'

-- ============ PREVIEW (read-only) ============
SELECT 'video_embeddings' AS tbl, COUNT(*) AS n FROM video_embeddings
  WHERE pdp_url LIKE 'https://' || :'shop' || '/%';
SELECT 'video_cache' AS tbl, COUNT(*) AS n FROM video_cache WHERE video_id IN
  (SELECT video_hash FROM video_embeddings WHERE pdp_url LIKE 'https://' || :'shop' || '/%');
SELECT 'ingest_jobs' AS tbl, COUNT(*) AS n FROM ingest_jobs WHERE shop = :'shop';
SELECT 'tag_events' AS tbl, COUNT(*) AS n FROM tag_events WHERE shop = :'shop';
SELECT 'scan_jobs' AS tbl, COUNT(*) AS n FROM scan_jobs WHERE shop = :'shop';
SELECT 'webhook_events' AS tbl, COUNT(*) AS n FROM webhook_events WHERE shop = :'shop';
SELECT 'shop_status_checks' AS tbl, COUNT(*) AS n FROM shop_status_checks WHERE shop = :'shop';
SELECT 'order_attribution' AS tbl, COUNT(*) AS n FROM order_attribution WHERE shop = :'shop';
-- Orphan rows with no shop in pdp_url (bulk/legacy imports) are NOT touched above.
-- Inspect them before deciding:
SELECT COUNT(*) AS orphan_embeddings FROM video_embeddings
  WHERE pdp_url IS NULL OR pdp_url = '' OR pdp_url NOT LIKE 'https://%';

-- ============ DELETE (transactional) ============
BEGIN;

-- Cache first (video_id = video_hash of the rows below).
DELETE FROM video_cache WHERE video_id IN
  (SELECT video_hash FROM video_embeddings WHERE pdp_url LIKE 'https://' || :'shop' || '/%');

-- Item data (verified rows included — the whole catalog is being replaced).
DELETE FROM video_embeddings WHERE pdp_url LIKE 'https://' || :'shop' || '/%';

-- Per-shop operational history.
DELETE FROM ingest_jobs WHERE shop = :'shop';
DELETE FROM tag_events WHERE shop = :'shop';
DELETE FROM scan_jobs WHERE shop = :'shop';
DELETE FROM webhook_events WHERE shop = :'shop';
DELETE FROM shop_status_checks WHERE shop = :'shop';
DELETE FROM order_attribution WHERE shop = :'shop';

-- KEEP shops row (OAuth token) — comment out the next line only to force reinstall:
-- DELETE FROM shops WHERE shop = :'shop';

-- ============ VERIFY (expect 0s for this shop) ============
SELECT 'video_embeddings' AS tbl, COUNT(*) AS n FROM video_embeddings
  WHERE pdp_url LIKE 'https://' || :'shop' || '/%';
SELECT 'ingest_jobs' AS tbl, COUNT(*) AS n FROM ingest_jobs WHERE shop = :'shop';
SELECT 'tag_events' AS tbl, COUNT(*) AS n FROM tag_events WHERE shop = :'shop';

COMMIT;
