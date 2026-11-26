-- Give every handle its own mark for how far it has been read, and keep a log of polls.
--
-- The poll used to resume from the newest tweet stored across a whole cadence tier. Each query
-- now resumes from the newest post the API has returned for its own handles, so one query
-- failing no longer moves the mark past posts it never fetched. The column starts from what is
-- already stored, which is where the old watermark stood, so the first poll after this asks
-- for the same window it would have anyway rather than re-buying a day of tweets.
--
-- Apply BEFORE deploying the Worker that reads these — its poll selects the column and writes
-- the log, and would fail against a database that has neither:
--   npx wrangler d1 execute nfl-daily-tweets --remote --file=migrations/0006_poll_marks.sql
--   npx wrangler deploy

ALTER TABLE handles ADD COLUMN seen_through TEXT;

UPDATE handles
   SET seen_through = (SELECT MAX(t.published_at) FROM tweets t
                        WHERE LOWER(t.author_handle) = handles.handle);

CREATE TABLE IF NOT EXISTS poll_log (
  at     TEXT PRIMARY KEY,
  ok     INTEGER NOT NULL,
  detail TEXT NOT NULL
);
