# NFL Daily

Personal NFL news app (PWA) + publishing pipeline. Live at https://maeisen15.github.io/nfl-daily/.
See [docs/PLAN.md](docs/PLAN.md) for the product spec and [docs/SETUP.md](docs/SETUP.md) for the
one-time Cloudflare wiring.

## How it runs

Three cadences, deliberately separate, because the three kinds of content go stale at very
different rates and cost very different amounts to refresh.

| What | Runs on | Cadence |
|---|---|---|
| **Tweets** | Cloudflare Worker polls twitterapi.io | every 5 min 9am–7pm ET, 15 min in the shoulders, dark overnight |
| **Articles, transactions, injuries** | GitHub Actions `refresh.yml` | hourly |
| **The digest** | cloud scheduled Claude agent, [pipeline/RUNBOOK.md](pipeline/RUNBOOK.md) | daily, 5pm ET |

Tweets never touch the pipeline on the way in. The Worker asks twitterapi.io for them directly
on a schedule and stores what comes back, and the app reads the store.

The cadence follows waking hours rather than running flat out, and that is a cost decision worth
understanding before changing it. twitterapi.io bills **~26 credits per request plus 15 credits
per tweet returned** (measured; 100,000 credits = $1.00). Two consequences shape the design:

- **One request covers every handle**, so the per-request floor is paid once no matter how many
  accounts are watched. Splitting the feed into fast and slow tiers would mean paying that floor
  more times for slower tweets — so everything shares one query at one cadence.
- **The `since_time` watermark is the cost control**, not an optimisation. Without it each poll
  re-returns tweets already stored and pays 15 credits for each of them again.

Polling only while Matt is awake costs about **$1.17/month**. Nothing is lost overnight: the 8am
poll's watermark reaches back to the last tweet stored and pulls the whole night in one request.

This replaced a twitterapi.io webhook, which cost about **$19/month** — filter rules bill 15
credits per rule per check whether or not anything matches, and the 255-character cap on a rule
meant 17 handles needed two of them. `pipeline/rules.py` still manages those rules but they are
deactivated; the docstring there explains what reactivating them costs.

Only the daily digest run commits. The hourly refresh deploys straight to Pages without a
commit, because `feed.json` changes every hour and committing it would add about a megabyte of
git objects a day.

The verify step in the runbook matters: a push that succeeds can still fail to deploy, and the
app then serves stale data while the run reports success.

## Layout

- `worker/` — Cloudflare Worker + D1: polls for tweets, holds the store, serves `/tweets`
- `pipeline/tweets.py` — pushes the handle → scope map to the Worker; manual backfill
- `pipeline/rules.py` — the retired webhook's filter rules; dormant, and costly to reactivate
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

```bash
python3 pipeline/tweets.py --mode sync-handles
```

The Worker builds its poll query from that table, so the YAML alone does nothing — this step is
what puts the handle on the air. No allowlist change needed.

Adding handles is close to free until it isn't: **21 handles fit in one query** (the API returns
zero tweets, silently and with no error, past roughly 512 characters — so the builder splits at
500). The 22nd handle forces a second request per poll, about **+$1.09/month**, then the price is
flat again until that query fills. `sync-handles` prints a note when you cross that line. Beyond
the split, each new account costs only its own tweets — a beat writer posting 15 a day is about
$0.07/month.

## Costs

Cloudflare and GitHub Actions are free at this volume. twitterapi.io is the only meter, at
about **$1.17/month**:

| | Per month |
|---|---|
| 140 polls/day × ~26 credits | $1.09 |
| ~100 tweets/day × 15 credits | $0.45 |
| overlap between the two (a poll returning tweets pays the tweets, not the floor) | −$0.37 |
| **total** | **~$1.17** |

The tweet line is the floor — it is what the content actually costs and no schedule change
reduces it. Only the poll line responds to cadence.

Check the balance with
`curl -H "X-API-Key: $TWITTERAPI_IO_KEY" https://api.twitterapi.io/oapi/my/info` (100,000
credits = $1.00), and `curl .../health` reports the last poll: what it asked for, what came
back, and its estimated credits. A poll that finds nothing and a poll that quietly broke look
identical from the outside, which is why that record exists.
