-- Route handles by vertical, not just by scope.
--
-- The app grew a second subject (politics) that shares this store with football. Scope alone
-- can't separate them for reading: football's feed asks for three scopes at once, so the app
-- would have to name every scope it wants, and every new scope would mean an app change. A
-- vertical is the one word that answers "whose feed is this".
--
-- Applied against the live database with:
--   npx wrangler d1 execute nfl-daily-tweets --remote --file=migrations/0004_verticals.sql
--
-- Existing rows are football's: it was the only vertical when they were written, which is what
-- the default encodes. The pipeline overwrites it on the next sync-handles either way.

ALTER TABLE handles ADD COLUMN vertical TEXT NOT NULL DEFAULT 'nfl';

-- The read path filters on it, and it is far more selective than published_at alone.
CREATE INDEX IF NOT EXISTS idx_handles_vertical ON handles (vertical, scope);
