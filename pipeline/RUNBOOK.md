# NFL Daily — Daily Digest Runbook

You are the scheduled agent for NFL Daily, Matt's personal NFL news app. You run **once a day
at 5pm ET** and you are responsible for exactly one thing the rest of the system cannot do:
**writing the digest**.

Everything else already happens without you:

| What | How | When |
|---|---|---|
| Tweets | twitterapi.io webhook → Cloudflare Worker | continuously, ~1 min after posting |
| Articles, transactions, injuries | GitHub Actions `refresh.yml` | hourly |
| Tweet completeness sweeps | GitHub Actions `tweets-sweep.yml` | daily + weekly |
| **The digest** | **you** | **now** |

So do not treat a stale article or a missing tweet as your problem to fix — say so at the end
and let the hourly job handle it. Your run is also the only one that commits, which is how
`web/data` in the repo stays in sync with what's live.

Work from the repo root.

## 1. Install dependencies

```bash
pip install -r pipeline/requirements.txt
```

If feedparser fails on its `sgmllib3k` sub-dependency (legacy sdist, known issue in the cloud
sandbox), fall back in order until one works:

```bash
pip install setuptools wheel && pip install -r pipeline/requirements.txt
pip install --no-build-isolation sgmllib3k && pip install -r pipeline/requirements.txt
```

## 2. Reconcile tweets

```bash
python3 pipeline/tweets.py --mode search --since-hours 26
```

Pulls anything the webhook missed into the Worker so the digest is written against a complete
day. Requires `TWITTERAPI_IO_KEY`, `NFL_DAILY_WORKER_URL`, and `NFL_DAILY_PUSH_SECRET`. If it
fails, continue — the digest will simply be written from whatever the Worker already holds.
Note it in the commit message.

## 3. Fetch

```bash
mkdir -p runtime
python3 pipeline/orchestrator.py --days 1 > runtime/package.json
```

Fetches articles, transactions, injuries, and podcasts, then reads tweets back out of the
Worker. Writes a run log to `runtime/runs/<ISO>.json` and the synthesis package to stdout.

**Abort rule:** if `sources_summary` shows every RSS source in `error`, do NOT publish — the app
would go blank. Stop and leave the repo untouched.

A `twitter_worker` entry in `error` means no tweets reached this run. That is worth reporting
but is not a reason to abort: the digest still has articles and structured data.

## 4. Synthesize the digest

Read `runtime/package.json` (keys: `team_coverage`, `structured_data`, `news_items`,
`source_health`, `run_log_path`, `prompt_path`). Then read `prompts/digest.md` — the single,
self-contained synthesis prompt (output structure + rubrics + hard rules). Write the multi-tab
slim digest exactly per that prompt.

Non-negotiables:
- Zero fabricated facts; transactions/injuries grounded ONLY in `structured_data`
- Every bullet carries a markdown link to its source
- No items older than the recency window

Write the result back into the run log at `run_log_path` (open the JSON, set these keys, save):

```json
{
  "digest_outputs": {
    "national": {"full_markdown": "..."},
    "ravens":   {"full_markdown": "..."},
    "rivals":   {"PIT": {"full_markdown": "..."}}
  },
  "prompt_version": "digest"
}
```

One `rivals.<code>` entry per rival in `team_coverage.rivals`.

## 5. Publish app JSON

```bash
python3 pipeline/publish.py
```

Writes `web/data/config.json`, `web/data/feed.json`, `web/data/digest.json` from the newest run
log.

**digest.json is only written when the run log has `digest_outputs`.** If you skipped step 4,
publish.py prints "kept existing digest.json" and leaves yesterday's in place — which means a
silent failure in step 4 looks like success here. Confirm digest.json was actually written.

**Safety guard:** publish.py refuses to write and exits non-zero (code 2) if the run is
degraded — zero items, or more than half of sources errored. This protects the live app: a
broken run keeps the last good data. If it refuses, do NOT commit — stop and report the reason.
Only pass `--force` if you have confirmed the empty result is a genuinely quiet news day.

## 6. Ship

Only if publish.py succeeded (exit 0):

```bash
git add web/data
git commit -m "Digest: <YYYY-MM-DD HH:MM ET> — <N> items, <tweet/article counts>"
git push origin main
```

Push directly to main — no PR. The Pages workflow deploys automatically (~1 min).

## 7. Verify the deploy landed

A successful push is not a successful deploy. Always finish with:

```bash
python3 scripts/verify_deploy.py
```

It polls the live site until it serves the run_id you just published, and exits non-zero if it
never does. Do not report the run as complete until this passes.

## Failure handling

- **Single-source errors:** proceed; they surface in the app's source-health section.
- **`twitter_worker` in error:** the Worker was unreachable. Check `curl $NFL_DAILY_WORKER_URL/health`.
  The digest goes out without tweets; the hourly refresh will restore them once the Worker is
  back. Report it.
- **publish.py refused (exit 2):** the run was degraded. Do not commit — the last good data stays
  live. Report the reason it printed. Don't `--force` unless you've verified it's a quiet day.
- **Push rejected (rare race):** pull --rebase and push again. The hourly job never commits, so
  a conflict here means a human pushed.
- **verify_deploy.py failed:** the data is committed and pushed — only the deploy is missing, so
  nothing needs re-fetching. Check the Actions tab for a failed run, then githubstatus.com for
  an Actions/Pages incident. Any new push to main re-triggers the deploy. Report the app as
  stale until it passes.
- **ESPN structured data failed** (`espn_injuries` / `espn_transactions` in `error`, or
  publish.py printed the 0-transactions/0-injuries warning): ESPN's API sits behind Akamai,
  which denies some callers — datacenter egress IPs far more than residential ones. The fetcher
  already retries three times across two hosts. If it still failed, re-run just the fetch once
  (step 3) — the denials are intermittent. If it fails again, publish anyway (news is
  unaffected), leave Transactions/Injuries empty per the grounding rule, and say so in the
  commit message. Never backfill those sections from news articles.
