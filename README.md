# NFL Daily

Personal NFL news app (PWA) + publishing pipeline. Live at https://maeisen15.github.io/nfl-daily/.
See [docs/PLAN.md](docs/PLAN.md) for the product spec and [docs/SETUP.md](docs/SETUP.md) for the
one-time Cloudflare wiring.

## How it runs

Three cadences, deliberately separate, because the three kinds of content go stale at very
different rates and cost very different amounts to refresh.

| What | Runs on | Cadence |
|---|---|---|
| **Tweets** | twitterapi.io webhook → Cloudflare Worker | continuous, ~1 min after posting |
| **Articles, transactions, injuries** | GitHub Actions `refresh.yml` | hourly |
| **The digest** | cloud scheduled Claude agent, [pipeline/RUNBOOK.md](pipeline/RUNBOOK.md) | daily, 5pm ET |

Tweets never touch the pipeline on the way in. twitterapi.io watches the handles in
`config/sources.yaml` and pushes each match to the Worker, which is what the app reads. Billing
is per matched tweet rather than per check, so "live" costs less than the twice-daily polling it
replaced. Two sweeps in `tweets-sweep.yml` backfill what that path can miss — a daily Advanced
Search pass for undelivered tweets, and a weekly per-handle pass for the case where Twitter's
search index itself dropped something.

Only the daily digest run commits. The hourly refresh deploys straight to Pages without a
commit, because `feed.json` changes every hour and committing it would add about a megabyte of
git objects a day.

The verify step in the runbook matters: a push that succeeds can still fail to deploy, and the
app then serves stale data while the run reports success.

## Layout

- `worker/` — Cloudflare Worker + D1 holding the tweet store (`/ingest`, `/push`, `/tweets`)
- `pipeline/tweets.py` — the tweet sweeps (Advanced Search reconcile, per-handle backstop)
- `pipeline/rules.py` — manages the twitterapi.io filter rules that drive the webhook
- `pipeline/orchestrator.py` — fetches articles/structured/podcasts, reads tweets from the Worker
- `pipeline/fetchers/` — per-type fetchers (rss, html, espn_api, generic api)
- `pipeline/publish.py` — transforms the newest run log into `web/data/*.json`
- `pipeline/RUNBOOK.md` — the step-by-step the daily digest agent follows
- `prompts/digest.md` — the single self-contained synthesis prompt (structure + rubrics + rules)
- `config/sources.yaml` — sources, teams (primary + rivals), and Twitter handles/flags
- `web/` — the PWA (index.html / app.js / app.css / sw.js) and its generated `data/`
- `docs/network-allowlist.txt` — domains the cloud environment must allow (keep in sync)
- `scripts/check_allowlist.py` — verifies every source domain is covered by the allowlist
- `scripts/verify_deploy.py` — confirms the live site is serving the run that was just pushed
- `tests/test_publish.py` — smoke test for the publish transform (`python3 tests/test_publish.py`)

## Adding a source

**An article source:** add it to `config/sources.yaml`. If it's on a new domain, also add that
domain (apex + wildcard) to `docs/network-allowlist.txt` **and** the cloud routine's network
allowlist, or the digest run gets a 403 fetching it.

**A Twitter handle:** add it under the right section of `config/sources.yaml`, then
`python3 pipeline/rules.py sync --activate` so twitterapi.io starts watching it. The handle →
scope map reaches the Worker on the next sweep. No allowlist change needed.

## Costs

Cloudflare and GitHub Actions are free at this volume. twitterapi.io runs about $2.70/month at
$0.00015 per tweet — check the balance with
`curl -H "X-API-Key: $TWITTERAPI_IO_KEY" https://api.twitterapi.io/oapi/my/info` (100,000
credits = $1.00). `python3 pipeline/rules.py deactivate` stops the meter.
