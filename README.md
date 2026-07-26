# NFL Daily

Personal NFL news app (PWA) + publishing pipeline. See docs/PLAN.md for the full spec.

- `pipeline/publish.py` — transforms an nfl-digest run log into `web/data/*.json`
- `web/` — the app (static PWA) and its generated data
- Pipeline runs as a cloud scheduled Claude agent at noon + 5pm ET (Phase 3)
