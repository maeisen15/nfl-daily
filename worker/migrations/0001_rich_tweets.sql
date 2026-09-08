-- Capture what twitterapi.io already sends and the app now renders: avatars, the full
-- retweeted post, thread structure, engagement counts, and outbound links.
--
-- Applied against the live database with:
--   npx wrangler d1 execute nfl-daily-tweets --remote --file=migrations/0001_rich_tweets.sql
--
-- Rows written before this ran keep NULLs in the new columns and render without an avatar or
-- counts. Nothing backfills them: the poll's watermark only reaches forward, so the store
-- refreshes itself as old rows age out of the seven-day retention window.

ALTER TABLE tweets ADD COLUMN author_avatar   TEXT;
ALTER TABLE tweets ADD COLUMN retweeted       TEXT;     -- JSON object, the post being retweeted
ALTER TABLE tweets ADD COLUMN conversation_id TEXT;
ALTER TABLE tweets ADD COLUMN reply_to_id     TEXT;
ALTER TABLE tweets ADD COLUMN like_count      INTEGER;
ALTER TABLE tweets ADD COLUMN retweet_count   INTEGER;
ALTER TABLE tweets ADD COLUMN reply_count     INTEGER;
ALTER TABLE tweets ADD COLUMN view_count      INTEGER;
ALTER TABLE tweets ADD COLUMN links           TEXT;     -- JSON array of expanded URLs

-- Threads are read by conversation, oldest first.
CREATE INDEX IF NOT EXISTS idx_tweets_conversation
  ON tweets (conversation_id, published_at);

-- Open Graph metadata for links tweeted by the tracked handles, so a tweet linking to an
-- article renders the same preview card Twitter shows. Keyed by the expanded URL and fetched
-- once; `status` records a failure so a dead link isn't retried on every poll forever.
CREATE TABLE IF NOT EXISTS link_cards (
  url         TEXT PRIMARY KEY,
  title       TEXT,
  description TEXT,
  image       TEXT,
  domain      TEXT,
  status      TEXT NOT NULL,       -- ok | empty | error
  fetched_at  TEXT NOT NULL
);
