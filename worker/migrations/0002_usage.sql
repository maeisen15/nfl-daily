-- What the poll actually did, per Eastern day.
--
-- Deliberately stores the inputs — requests made, tweets returned — rather than a dollar
-- figure. twitterapi.io publishes no billing API and no cost header, so every price here is
-- computed from a formula that has been measured but not confirmed against an invoice. Keeping
-- the raw counts means correcting the formula fixes the whole history rather than only the
-- days after the fix.

CREATE TABLE IF NOT EXISTS usage_daily (
  day      TEXT PRIMARY KEY,          -- YYYY-MM-DD, Eastern
  polls    INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  tweets   INTEGER NOT NULL DEFAULT 0
);

-- Tweets are billed per tweet returned, so a handle's share of the bill is exactly its share
-- of the tweets. This survives the seven-day prune of the tweets table, which is the whole
-- reason it exists as its own table rather than a query over tweets.
CREATE TABLE IF NOT EXISTS usage_handle_daily (
  day    TEXT NOT NULL,
  handle TEXT NOT NULL,
  tweets INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, handle)
);

CREATE INDEX IF NOT EXISTS idx_usage_handle_day ON usage_handle_daily (day);
