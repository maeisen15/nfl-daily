-- Daily practice-report snapshots.
--
-- NFL.com shows only the most recent practice day. The report worth reading is the week laid
-- out side by side — Wednesday, Thursday, Friday, then the game status — which exists only if
-- each day is kept. The hourly pipeline deploys without committing, so there is nowhere in the
-- repo for this to accumulate; it lives here instead.
--
-- Keyed by day so re-running the pipeline within a day corrects that day rather than
-- duplicating it.

CREATE TABLE IF NOT EXISTS injury_reports (
  day      TEXT NOT NULL,       -- YYYY-MM-DD, Eastern
  team     TEXT NOT NULL,       -- BAL
  player   TEXT NOT NULL,
  position TEXT,
  injury   TEXT,
  practice TEXT,                -- DNP | Limited | Full
  status   TEXT,                -- Questionable | Out | Doubtful
  PRIMARY KEY (day, team, player)
);

CREATE INDEX IF NOT EXISTS idx_injury_team_day ON injury_reports (team, day);
