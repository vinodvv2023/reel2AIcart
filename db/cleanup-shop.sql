-- Fresh-start reset for a full catalog replacement.
-- Neon-SQL-editor safe: plain SQL only, NO psql backslash commands (\set etc.)
-- — the editor rejects those, which is why the previous version deleted nothing.
--
-- Option A (you are here: starting fresh) wipes ALL item + history data.
-- Option B (further down) targets ONE shop only — use it when other
-- tenants' data must survive.
--
-- The shops row (OAuth token) is KEPT in both options so the store does NOT
-- need reinstalling. Delete it only to force a fresh OAuth install.

-- ============ Option A: FULL RESET (run this) ============
BEGIN;

TRUNCATE video_cache;
TRUNCATE video_embeddings;
TRUNCATE ingest_jobs RESTART IDENTITY;
TRUNCATE tag_events RESTART IDENTITY;
TRUNCATE scan_jobs RESTART IDENTITY;
TRUNCATE webhook_events RESTART IDENTITY;
TRUNCATE shop_status_checks RESTART IDENTITY;
TRUNCATE order_attribution RESTART IDENTITY;
-- shops intentionally NOT truncated (keeps OAuth token).

-- Verify (expect 0 on every row; shops = 1 per installed store).
SELECT 'video_embeddings' AS tbl, COUNT(*) AS n FROM video_embeddings
UNION ALL SELECT 'video_cache', COUNT(*) FROM video_cache
UNION ALL SELECT 'ingest_jobs', COUNT(*) FROM ingest_jobs
UNION ALL SELECT 'tag_events', COUNT(*) FROM tag_events
UNION ALL SELECT 'scan_jobs', COUNT(*) FROM scan_jobs
UNION ALL SELECT 'webhook_events', COUNT(*) FROM webhook_events
UNION ALL SELECT 'shop_status_checks', COUNT(*) FROM shop_status_checks
UNION ALL SELECT 'order_attribution', COUNT(*) FROM order_attribution
UNION ALL SELECT 'shops (kept)', COUNT(*) FROM shops;

COMMIT;

-- ============ Option B: ONE SHOP ONLY (skip if you ran A) ============
-- Replace SHOP_DOMAIN below with the store (e.g. reel2aicart-test.myshopify.com),
-- run the PREVIEW first, then the DELETE block.
--
-- -- Preview:
-- SELECT 'video_embeddings', COUNT(*) FROM video_embeddings WHERE pdp_url LIKE '%SHOP_DOMAIN%';
-- SELECT 'video_cache', COUNT(*) FROM video_cache WHERE video_id IN
--   (SELECT video_hash FROM video_embeddings WHERE pdp_url LIKE '%SHOP_DOMAIN%');
-- SELECT 'ingest_jobs', COUNT(*) FROM ingest_jobs WHERE shop = 'SHOP_DOMAIN';
-- SELECT 'tag_events', COUNT(*) FROM tag_events WHERE shop = 'SHOP_DOMAIN';
-- SELECT 'scan_jobs', COUNT(*) FROM scan_jobs WHERE shop = 'SHOP_DOMAIN';
-- SELECT 'webhook_events', COUNT(*) FROM webhook_events WHERE shop = 'SHOP_DOMAIN';
-- SELECT 'shop_status_checks', COUNT(*) FROM shop_status_checks WHERE shop = 'SHOP_DOMAIN';
-- SELECT 'order_attribution', COUNT(*) FROM order_attribution WHERE shop = 'SHOP_DOMAIN';
--
-- -- Delete (transactional):
-- BEGIN;
-- DELETE FROM video_cache WHERE video_id IN
--   (SELECT video_hash FROM video_embeddings WHERE pdp_url LIKE '%SHOP_DOMAIN%');
-- DELETE FROM video_embeddings WHERE pdp_url LIKE '%SHOP_DOMAIN%';
-- DELETE FROM ingest_jobs WHERE shop = 'SHOP_DOMAIN';
-- DELETE FROM tag_events WHERE shop = 'SHOP_DOMAIN';
-- DELETE FROM scan_jobs WHERE shop = 'SHOP_DOMAIN';
-- DELETE FROM webhook_events WHERE shop = 'SHOP_DOMAIN';
-- DELETE FROM shop_status_checks WHERE shop = 'SHOP_DOMAIN';
-- DELETE FROM order_attribution WHERE shop = 'SHOP_DOMAIN';
-- COMMIT;
