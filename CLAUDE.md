# NFL Daily

A private Twitter client for a curated list of NFL accounts, plus the article, schedule and
brief surfaces around it. One user, one iPhone, installed to the home screen. Live at
https://maeisen15.github.io/nfl-daily/.

Matt has followed NFL news on Twitter for years and wanted the part he actually uses without
the part he doesn't. **The Tweets tab is the product.** Everything else earns its place against
it. Where a design question is ambiguous, do what Twitter does — the reference screenshots are
in `docs/design-reference/`.

`docs/PLAN.md` describes what the app does and why, in detail. Read it before changing
behaviour.

## Shape

```
worker/        Cloudflare Worker + D1: polls twitterapi.io, serves /tweets, /usage, /injuries
pipeline/      hourly fetch of articles, schedule, practice reports, the game-week dossier
scripts/       verify_handles, fetch_source_icons, fetch_team_logos, check_allowlist, verify_deploy
web/           the app: vanilla ES modules, no framework, no build step
config/sources.yaml   the single source of truth for every source, handle and beat writer
prompts/digest.md     what the daily brief agent writes
```

Three data paths, deliberately separate. Tweets come live from the Worker. Articles, schedule
and the dossier are rebuilt hourly by GitHub Actions into `web/data/*.json`. The written briefs
are produced once a day by a cloud agent.

## Rules that have been learned the hard way

**Silent failure is the house specialty.** A misspelled handle, a dead RSS selector, an ESPN
parameter that is accepted and ignored, a D1 query that exceeds the 100-parameter cap inside a
swallowed try — every one of these looks exactly like a quiet news day. When adding a source or
a fetch, ask what it looks like when it returns nothing, and make that visible.

**Verify, don't assume.** Run the thing and read the output. `scripts/verify_handles.py` before
syncing handles, `scripts/check_allowlist.py` before pushing a new domain, `python3
tests/test_publish.py` for the pipeline.

**Cost is small but real.** twitterapi.io bills per request and per tweet returned, and
publishes no billing API — the usage view computes it. Roughly $3.60/month at 41 handles. Flag
any spend before incurring it, however small. Everything else — ESPN, NFL.com, Open-Meteo,
Cloudflare — is free.

**Handles are configuration, not code.** Edit `config/sources.yaml`, then
`python3 pipeline/tweets.py --mode sync-handles`. The YAML alone does nothing.

**The Worker is deployed by hand** (`cd worker && npx wrangler deploy`); the web app deploys on
push to `main`. D1 migrations are applied with
`npx wrangler d1 execute nfl-daily-tweets --remote --file=migrations/<file>.sql`.

## Working with Matt

He is a strategy professional, not a developer — he reads code at a basic level and cannot
write it. Every technical decision is yours to make and explain in plain English.

He would rather have it built correctly than built small: when the choice is patching or
restructuring, propose the restructure. He thinks in model-time, so thoroughness is close to
free.

Grill him before building anything substantial — put the whole frontier of open questions to
him at once, each with a recommendation. He disagrees usefully and often improves the design.
Find facts yourself rather than asking him for them.

Preview on a phone-sized frame before pushing: `python3 -m http.server 8000` inside `web/`, then
open `/debug-frame.html`. Port 8000 matters — the Worker's CORS allowlist only accepts that one
and the live site.

Always ask before pushing.
