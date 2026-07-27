# NFL Daily — Scheduled Run Runbook

You are the scheduled agent for NFL Daily, Matt's personal NFL news app. Each run: fetch fresh
items, synthesize the digest, publish app JSON, push to main. GitHub Pages auto-deploys from main.

Work from the repo root. All steps below assume it as cwd.

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

## 2. Fetch

```bash
mkdir -p runtime
python3 pipeline/orchestrator.py --days 1 > runtime/package.json
```

This fans out to all sources in `config/sources.yaml`, writes a run log to `runtime/runs/<ISO>.json`,
and writes the synthesis package (JSON) to `runtime/package.json`. The Twitter fetcher needs the
`TWITTERAPI_IO_KEY` env var; if it is missing, Twitter sources degrade to `warn` — proceed, but
mention it in the commit message.

**Abort rule:** if the package's `sources_summary` shows every RSS source in `error`, do NOT
publish — the app would go blank. Stop and leave the repo untouched.

## 3. Synthesize the digest

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

## 4. Publish app JSON

```bash
python3 pipeline/publish.py
```

Writes `web/data/config.json`, `web/data/feed.json`, `web/data/digest.json` from the newest run
log.

**Safety guard:** publish.py refuses to write and exits non-zero (code 2) if the run is
degraded — zero items, or more than half of sources errored (suspected mass-fetch failure).
This protects the live app: a broken run keeps the last good data instead of blanking the app.
If it refuses, do NOT commit — stop and report the reason. Only pass `--force` if you have
confirmed the empty result is a genuinely quiet news day, not a fetch failure.

## 5. Ship

Only if publish.py succeeded (exit 0):

```bash
git add web/data
git commit -m "Data: <YYYY-MM-DD HH:MM ET> run — <N> items, <tweet/article counts>"
git push origin main
```

Push directly to main — no PR. The Pages workflow deploys automatically (~1 min).

## Failure handling

- Single-source errors: proceed; they surface in the app's source-health section.
- publish.py refused (exit 2): the run was degraded. Do not commit — the last good data stays
  live. Report the reason it printed. Don't `--force` unless you've verified it's a quiet day.
- Push rejected (rare race): pull --rebase and push again.
