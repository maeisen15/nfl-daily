-- Let a vertical be polled less often than the rest.
--
-- Every handle used to ride one cadence. A vertical whose news does not move by the minute can
-- now be polled every half hour instead, which pays the per-request floor a sixth as often for
-- the queries its handles fill. NULL means the waking-hours cadence, so existing rows keep
-- behaving exactly as they did.
--
-- Apply BEFORE deploying the Worker that reads this column — its handle sync writes to it, and
-- would fail against a table that does not have it:
--   npx wrangler d1 execute nfl-daily-tweets --remote --file=migrations/0005_poll_minutes.sql
--   npx wrangler deploy
--
-- The pipeline fills the column on the next sync-handles.

ALTER TABLE handles ADD COLUMN poll_minutes INTEGER;
