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
- **Freshness:** tweets live (webhook push, ~1 min); articles hourly; digest once daily at 5pm ET.
- **Pipeline home:** Cloudflare Worker for tweets, GitHub Actions for articles, cloud scheduled
  Claude agent for the digest. Mac not required for any of it.

## Architecture

```
[twitterapi.io filter rules]  --push on each tweet-->  [Cloudflare Worker + D1]
                                                              ^          |
[GitHub Actions, hourly] --fetch articles--> publish.py -------+          |
                              → web/data/*.json → deploy to Pages         |
                                                                          |
[cloud agent, 5pm ET] --reconcile--> tweets.py --> Worker                 |
                      --synthesize digest--> publish.py → commit + push    |
                                                                          v
[iPhone PWA] reads web/data/*.json (articles, digest) + Worker /tweets (live)
```

## Data contracts (web/data/)

- `config.json` — scopes, labels, default scope. Generated from sources.yaml.
- `feed.json` — all window items: tweets, articles, transactions, injuries. Each item: id, type,
  scopes[], source, title/text, url, published_at, author (tweets), team (txn/injury), media[].
  Tweets also carry `quoted` — the post this one quotes, as {author_handle, author_name, text,
  url, published_at, media[]}, or null. One level deep; a quote of a quote is not followed.
- `digest.json` — per-scope digest markdown + generated_at.

## Phases

1. **Data layer** — publish.py transforms a run log → app JSON. ✅ built against real run logs.
2. **App** — three-tab PWA in `web/`, built on real data. Local preview → deploy.
3. **Cloud migration** — pipeline code moves into this repo; scheduled agent runs noon/5pm ET; secrets (twitterapi.io) in cloud env.
4. **Tune** — slim-digest prompt (`prompts/digest.md`), tweet media capture in fetcher, cost check-in, then deprecate old skill.

## Known gaps / future

- Link previews: `cleanTweet` strips t.co stubs, so a tweet linking to an article shows no link.
  `entities.urls[].expanded_url` has the real destination if this is worth rendering.
- The digest's cron is fixed in UTC, so it lands at 5pm ET in summer and 4pm ET in winter.
- Push notifications — future. The Worker already sees every tweet as it arrives, which is the
  hard part of a "breaking news" alert.
