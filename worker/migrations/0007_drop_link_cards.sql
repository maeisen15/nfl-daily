-- The app shows an author's link in the sentence it was written in, not as a preview card, so
-- nothing reads this cache any more.
--
-- Apply AFTER deploying the Worker that no longer queries it — the one before it joins this
-- table into every /tweets response:
--   npx wrangler deploy
--   npx wrangler d1 execute nfl-daily-tweets --remote --file=migrations/0007_drop_link_cards.sql

DROP TABLE IF EXISTS link_cards;
