# NFL Daily

Personal NFL news app (PWA) + publishing pipeline. Live at https://maeisen15.github.io/nfl-daily/.
See [docs/PLAN.md](docs/PLAN.md) for the full spec.

## How it runs

A cloud scheduled Claude agent runs twice daily (noon + 5pm ET), following
[pipeline/RUNBOOK.md](pipeline/RUNBOOK.md): fetch → synthesize the digest → publish → push.
Pushing to `main` auto-deploys the app via GitHub Pages. No local machine required.

## Layout

- `pipeline/orchestrator.py` — fetches all sources in `config/sources.yaml` and writes a run log
- `pipeline/fetchers/` — per-type fetchers (rss, html, espn_api, twitter, generic api)
- `pipeline/publish.py` — transforms the newest run log into `web/data/*.json`
- `pipeline/RUNBOOK.md` — the step-by-step the scheduled agent follows each run
- `prompts/digest.md` — the single self-contained synthesis prompt (structure + rubrics + rules)
- `config/sources.yaml` — sources, teams (primary + rivals), and Twitter handles/flags
- `web/` — the PWA (index.html / app.js / app.css / sw.js) and its generated `data/`
- `docs/network-allowlist.txt` — domains the cloud environment must allow (keep in sync with sources)

## Adding a source

Add it to `config/sources.yaml`. If it's on a new domain, also add that domain (apex + wildcard)
to `docs/network-allowlist.txt` **and** the cloud routine's network allowlist, or the scheduled
run gets a 403 fetching it.
