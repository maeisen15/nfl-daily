# NFL Daily — Project Plan

Personal NFL app for Matt. Replaces (deprecates) the local `nfl-digest` HTML site once live.

## Product spec (agreed 2026-07-26)

- **Delivery:** PWA installed to iPhone home screen. No App Store, no Apple developer account. $0 hosting.
- **Tabs (bottom nav):**
  1. **Home** — slimmed digest: key transactions, key injuries, big news only. "Last updated" stamp.
  2. **Tweets** — scrollable feed of curated-account tweets rendered as cards. Tap → opens in X app.
  3. **Articles** — card list of fetched articles, newest first. Tap → Universal Links (publisher app if installed, else browser).
- **Scope switcher** (top): Ravens / NFL / Steelers (+future rivals). Default scope configurable, ships as Ravens.
- **Teams:** config-driven from `sources.yaml` `team_coverage` (BAL primary, PIT rival; more rivals addable by config only).
- **No login** — unguessable URL. **No push notifications** at launch (future add-on).
- **Freshness:** full pipeline run 2x/day — **noon and 5pm ET**. Track costs, may increase later.
  (Architecture keeps fetch and synthesis decoupled so fetch-only frequency can be raised cheaply later.)
- **Pipeline home:** cloud scheduled Claude agent (Anthropic-hosted routine), repo on GitHub. Mac not required.

## Architecture

```
[cloud scheduled agent, 12pm + 5pm ET]
  fetch (pipeline/fetchers, from sources.yaml)
    → synthesize slim digest (Claude, prompts/)
    → publish.py → web/data/*.json
    → deploy web/ to static host
[iPhone PWA] reads web/data/*.json
```

## Data contracts (web/data/)

- `config.json` — scopes, labels, default scope. Generated from sources.yaml.
- `feed.json` — all window items: tweets, articles, transactions, injuries. Each item: id, type,
  scopes[], source, title/text, url, published_at, author (tweets), team (txn/injury), media[] (future).
- `digest.json` — per-scope digest markdown + generated_at.

## Phases

1. **Data layer** — publish.py transforms a run log → app JSON. ✅ built against real run logs.
2. **App** — three-tab PWA in `web/`, built on real data. Local preview → deploy.
3. **Cloud migration** — pipeline code moves into this repo; scheduled agent runs noon/5pm ET; secrets (twitterapi.io) in cloud env.
4. **Tune** — slim-digest prompt (new, replaces digest-v2 verbosity), tweet media capture in fetcher, cost check-in, then deprecate old skill.

## Known gaps / future

- Tweet media (images) not captured by current fetcher — add to fetcher in Phase 4 so tweet cards can show images.
- Push notifications — future.
- Hourly fetch-only refresh — future, cost-gated.
