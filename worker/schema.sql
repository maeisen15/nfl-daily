-- NFL Daily tweet store.
--
-- Two writers land here: the twitterapi.io webhook (fast, possibly thin payloads) and the
-- pipeline's reconciliation sweep (slower, always full tweet objects). `richness` lets the
-- fuller record win an upsert race so a thin webhook row never overwrites media or a quoted
-- post that the sweep already recovered.

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
  richness       INTEGER NOT NULL DEFAULT 0,  -- 0 webhook-thin, 1 full object
  source         TEXT NOT NULL,          -- webhook | search | backstop
  ingested_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tweets_published ON tweets (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_tweets_author    ON tweets (author_handle, published_at DESC);

-- handle -> scope routing, synced from config/sources.yaml by the pipeline so the YAML stays
-- the single source of truth and adding a handle never needs a Worker redeploy.
CREATE TABLE IF NOT EXISTS handles (
  handle       TEXT PRIMARY KEY,         -- lowercased
  display_name TEXT,
  scope        TEXT NOT NULL,            -- BAL | national | PIT | ...
  feed_only    INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL
);
