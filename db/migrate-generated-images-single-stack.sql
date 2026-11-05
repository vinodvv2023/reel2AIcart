-- Style rename: 'single-folded' -> 'single-stack' (issue #10 follow-up).
-- Neon-SQL-editor safe: plain SQL only, NO psql backslash commands.
-- Idempotent: safe to re-run (UPDATE matches nothing, DROP uses IF EXISTS,
-- ADD is skipped when the constraint already has the new definition... it
-- does not, so guard with a DO block instead - see below).
-- Fresh setups do NOT need this file: db/schema.sql already carries the new list.

UPDATE generated_images SET style = 'single-stack' WHERE style = 'single-folded';

ALTER TABLE generated_images DROP CONSTRAINT IF EXISTS generated_images_style_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'generated_images_style_check'
  ) THEN
    ALTER TABLE generated_images ADD CONSTRAINT generated_images_style_check
      CHECK (style IN ('flat-lay','folded-stack','single-stack','ghost-mannequin','hanger','on-actor'));
  END IF;
END $$;

-- Verify (expect zero rows on the first SELECT; constraint listed on the second).
SELECT style, COUNT(*) AS n FROM generated_images GROUP BY style ORDER BY style;
SELECT conname FROM pg_constraint WHERE conrelid = 'generated_images'::regclass AND contype = 'c';
