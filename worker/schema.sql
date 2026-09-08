-- NFL Daily tweet store.
--
-- Two writers land here: the twitterapi.io webhook (fast, possibly thin payloads) and the
-- pipeline's reconciliation sweep (slower, always full tweet objects). `richness` lets the
-- fuller record win an upsert race so a thin webhook row never overwrites media or a quoted
-- post that the sweep already recovered.
--
-- This is the shape a fresh database is created with. An existing database is brought up to
-- it by the files in migrations/.

CREATE TABLE IF NOT EXISTS tweets (
  id             TEXT PRIMARY KEY,
  author_handle  TEXT NOT NULL,
  author_name    TEXT,
  text           TEXT NOT NULL,
  url            TEXT,
  published_at   TEXT NOT NULL,          -- ISO8601 UTC
  is_retweet     INTEGER NOT NULL DEFAULT 0,
  is_reply       INTEGER NOT NULL DEFAULT 0,
  is_self_thread INTEGER NOT NULL DEFAULT 0,
  rt_author      TEXT,                   -- handle this retweets, when is_retweet
  media          TEXT,                   -- JSON array, '[]' when none
  quoted         TEXT,                   -- JSON object, NULL when none
  author_avatar  TEXT,                   -- profile image; the left column of every row
  retweeted      TEXT,                   -- JSON object, the post being retweeted
  conversation_id TEXT,                  -- groups a thread
  reply_to_id    TEXT,                   -- orders it
  like_count     INTEGER,
  retweet_count  INTEGER,
  reply_count    INTEGER,
  view_count     INTEGER,                -- counts are a snapshot at fetch time, never updated
  links          TEXT,                   -- JSON array of expanded URLs
  richness       INTEGER NOT NULL DEFAULT 0,  -- 0 thin, 1 full object, 2 full + avatar/counts
  source         TEXT NOT NULL,          -- webhook | search | backstop
  ingested_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tweets_published ON tweets (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_author    ON tweets (author_handle, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_conversation ON tweets (conversation_id, published_at);

-- Open Graph metadata for links tweeted by the tracked handles, so a tweet linking to an
-- article renders a preview card. Keyed by the expanded URL and fetched once; `status` records
-- a failure so a dead link isn't retried on every poll forever.
CREATE TABLE IF NOT EXISTS link_cards (
  url         TEXT PRIMARY KEY,
  title       TEXT,
  description TEXT,
  image       TEXT,
  domain      TEXT,
  status      TEXT NOT NULL,          -- ok | empty | error
  fetched_at  TEXT NOT NULL
);

-- handle -> scope routing, synced from config/sources.yaml by the pipeline so the YAML stays
-- the single source of truth and adding a handle never needs a Worker redeploy.
CREATE TABLE IF NOT EXISTS handles (
  handle       TEXT PRIMARY KEY,         -- lowercased
  display_name TEXT,
  scope        TEXT NOT NULL,            -- BAL | national | PIT | ...
  feed_only    INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);

-- Small key/value scratch for the poller. Its purpose is diagnostic: a poll that returns
-- nothing looks identical to a poll that silently broke, so every run records what it asked
-- for and what came back, and /health surfaces the last one.
CREATE TABLE IF NOT EXISTS meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,           -- JSON
  updated_at TEXT NOT NULL
);
