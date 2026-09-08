# NFL Daily — Product Plan

A private Twitter client for a curated list of NFL accounts, plus the article and brief
surfaces that hang off it. One user, one iPhone, installed to the home screen.

## What this app is for

Matt has consumed NFL news through Twitter for years: scroll a curated set of accounts in
chronological order, read the takes, click through to articles. The problem is Twitter itself —
an engagement machine that keeps pushing content outside the topics he wants. This app is the
part of Twitter he actually uses, with none of the part he doesn't.

That framing decides most design arguments. **The Tweets tab is the product.** Articles are the
secondary surface. The daily brief is a convenience that has to earn its place.

The app should feel like Twitter. Not "inspired by" — the same information design, the same
gestures, the same density. Where a decision is ambiguous, do what Twitter does. The reference
shots the feed is built against are in [design-reference/](design-reference/).

## Navigation

Three tabs along the bottom: **Tweets** (the default — the app opens here), **Articles**,
**Brief**.

Scope tabs sit at the top, styled and behaving like Twitter's list tabs: **Ravens · NFL ·
Steelers**, swipeable left/right, with the active scope's accent underlining it. Ravens is the
default. Both choices persist.

## Tweets

Chronological, newest first, seven days deep, scoped by the top tabs.

### The row

Twitter's layout: a 40px avatar in a left column, content in a right column, hairline
separators, no card borders.

```
[avatar]  Jeff Zrebiec  @jeffzrebiec · 2h
          Jesse Minter announces that Jovaughn Gwyn will start
          at center for Ravens in Week 1.
          [media]
          [quoted tweet card]
          [link preview card]
          💬 3    🔁 10    ♥ 314    ıl 14K              𝕏
```

- Names render in the body sans face, normal case. Outlet suffixes like `(The Athletic)` are
  stripped from display names everywhere.
- The name row never wraps: name and handle truncate, the timestamp is pinned and always
  visible.
- Text clamps at 8 lines with an inline `Show more`.
- Media renders full column width; tapping opens a pinch-zoomable full-screen viewer. Video is
  tap-to-play, GIFs autoplay muted and loop.

### Retweets

A retweet renders as the **original** post — the original author's avatar, name, full text and
counts — under a small `🔁 X reposted` line. Never Twitter's truncated `RT @handle: …` string,
which is only a fallback for rows stored before the Worker captured the retweeted object.

### Quoted tweets

A bordered card carrying the quoted author's avatar, name, handle, time and text, **tappable**
into that tweet's own detail view. A quoted tweet with one image shows it as a small square
thumbnail beside the text rather than full width.

### Threads

Consecutive posts by one author in one conversation group as a single feed item. Up to three
render inline and connected by the vertical line down the avatar column; longer threads show
the opening two plus `Show this thread (N)`.

### Link preview cards

A tweet linking to an article shows the destination's `og:image` and `og:title` as a card with
the domain beneath. This is a primary way articles get found, so it matters as much as anything
else in the feed.

### Engagement row

Reply, retweet, like and view counts, plus an X icon opening the tweet on x.com. Counts are
captured when the tweet is fetched and never updated — a frozen snapshot costs nothing and
refreshing would mean re-buying tweets already paid for.

The **heart is the only control**. Tapping it copies the whole tweet into `localStorage`, so a
like outlives the seven-day prune on the server. Storage is on the device: no server, no
account, no cost, ~5MB against ~1KB per tweet. The **Liked** view is the heart in the masthead,
ordered by when things were liked. The like store sits behind a small interface so it can move
to the Worker's D1 later without any view knowing.

### Refresh

Pull-to-refresh, a 60-second background poll while the app is visible, and an `N new posts`
pill that holds new tweets out of the feed so the list never shifts under a thumb mid-read. The
ceiling is the Worker's own five-minute poll of twitterapi.io.

### Detail view

Tapping a row opens `#/tweet/<id>`: the tweet larger, its quoted post tappable into its own
detail, the full thread below, the engagement row, and a back control that restores the exact
scroll position. Scroll position is preserved across every navigation.

## Articles

A scannable list. The row leads with the publisher's own mark, because which outlet ran a story
is the strongest signal for whether it's worth opening, and a name has to be read where a logo
is recognised.

```
┌──────┬──────────────────────────┬────────┐
│ [A]  │  Baltimore Ravens tab    │        │
│  4h  │  Jovaughn Gwyn as their  │  IMG   │
│      │  starting center         │        │
└──────┴──────────────────────────┴────────┘
```

Logo and time form one centred block in the tweet row's 40px column; the thumbnail is 72px.
Headline only — a first-line preview said little the headline didn't and cost the density that
makes eighty items scannable.

Images come from the RSS entry where it carries one, otherwise the article's `og:image`.
Coverage is currently 100% across all sources. A row whose image fails to load collapses to its
text form rather than showing a broken glyph.

### Deduplication and ordering

The same story from several outlets collapses to one row: the highest-ranked source wins and
the others disappear silently. Clustering is tuned **conservative** — when two articles are
only probably the same story, both stay. A missed merge is invisible; a wrong merge hides an
article. The thresholds are `CLUSTER_MIN_JACCARD` / `CLUSTER_MIN_OVERLAP` in `publish.py`.

One card layout, one sort function, a per-scope weighting:

- **Ravens** sorts by source tier, then recency. Athletic 10 → Banner 20 → Sun 30 → Russell
  Street 40 → Ravens official 50.
- **NFL and rivals** sort by cluster size, then recency — a story three outlets ran matters
  more than one nobody else picked up.

**Day boundaries win in both.** A two-day-old piece never sits above today's news.

## Brief

The daily brief, per scope: **Summary, Transactions, Injuries**. Source Health is fetch
diagnostics and is both absent from the prompt and filtered at render, so a digest written
before that change can't show it either.

## Design system

Twitter's information design on a light default. System sans for all content; Barlow Condensed
survives only in the wordmark. Three themes — Light, Dim, Dark — cycled by the masthead button.
Neutral grays, not tinted; the per-scope accent appears only on the active scope tab, the
active bottom tab, and links. Hairline separators, full-bleed content, boxed cards only where
Twitter uses one: quoted tweets and link previews.

## Architecture

```
worker/          Cloudflare Worker + D1: polls twitterapi.io, resolves link cards, serves /tweets
  migrations/    D1 schema changes, applied with `wrangler d1 execute --remote --file=`
pipeline/        fetches articles/structured data, clusters, writes web/data/*.json
scripts/         fetch_source_icons.py, check_allowlist.py, verify_deploy.py
web/
  js/
    data.js      fetching, caching, pagination, offline fallback
    store.js     app state: scope, route, feed, pending, likes
    router.js    hash routes: #/tweets, #/tweet/<id>, #/liked, #/articles, #/brief
    views/       feed, tweet, detail, articles, brief, liked, lightbox, chrome
    lib/         dom, icons, time, likes
  sw.js          data network-first; shell stale-while-revalidate
```

Vanilla JavaScript, no framework, no build step — in a project like this the dependency is the
durability risk, not the code. View functions take data and return DOM elements; nothing
concatenates HTML, which is why text from other people can't become markup.

The service worker serves the shell **stale-while-revalidate**. Cache-first pinned the app to
whatever it had stored and made every deploy invisible until a version string changed by hand.
The consequence worth knowing: a change lands on the second open, not the first.

### Tweet data

The Worker captures what twitterapi.io sends and the app renders: `author_avatar`, the full
`retweeted` object, `conversation_id` / `reply_to_id`, the four engagement counts, and `links`.
A `link_cards` table caches `url → {title, image, domain}`, fetched once at ingest with
HTMLRewriter. Open Graph URLs are HTML-entity-decoded before use — publishers routinely escape
the ampersands in them, and image CDNs reject the result.

Retention is seven days. Replies to accounts other than the author's own thread are excluded at
ingest: showing a reply without its parent is confusing, and fetching parents costs 15 credits
each.

Rows written before a field existed keep NULLs and render without it. Nothing backfills
automatically — the poll watermark only reaches forward — so the store heals as rows age out.
`pipeline/tweets.py --mode search --since-hours N` forces it, at 15 credits per tweet returned.

## Adding things

**An article source:** add it to `config/sources.yaml` with a `rank:`, add any new domain to
`docs/network-allowlist.txt` **and** the cloud routine's allowlist, then run
`python3 scripts/fetch_source_icons.py` for its logo. A site that blocks the icon crawl gets an
`icon_url:` in its config entry, which is what espn.com needs.

**A Twitter handle:** add it to `config/sources.yaml`, then `python3 pipeline/tweets.py --mode
sync-handles`. The Worker builds its poll query from that table, so the YAML alone does
nothing.

Handle cost: 18–21 are free, each further block of 21 adds about $1.09/month, and each handle's
own tweets run about $0.07/month. Roughly 60 handles lands near $4.50/month against a $5–10
ceiling. **Money is not the constraint; attention is.** Be generous with Ravens handles and
picky with national ones — thirty accounts echoing the same Schefter post is the noise this app
exists to escape.

## Not built yet

- **Search** over stored tweets, using D1's full-text index. No API calls, no cost.
- **More handles** — the list is Matt's to choose.
- **Scores and schedule** — a thin band showing the next Ravens game or the live score. First
  thing after search.
- **Gameday mode** — pregame tunnel and warmup content, live injury updates, post-game video
  and articles. Worth designing properly; the game itself is watched elsewhere.
- **Rivals** — whether Steelers stays its own scope or rivals collapse into NFL with one beat
  writer each. Decide after living with the feed.
- **Likes in D1** — durable and cross-device, if losing local likes ever matters.
- **"What you missed"** — a brief generated against unseen tweets rather than a fixed 24-hour
  window. Only meaningful once unread state exists.
- **Replies to other accounts** — needs parent-tweet fetching to be worth showing.
- **Push notifications** — declined.

## Known problems

- **`nfl_com_news` returns zero items.** Its `link_pattern` matches nothing on the current
  page, so NFL.com contributes no articles at all. Pre-existing and unfixed.
- **`nfl_com_injuries` / `nfl_com_transactions`** warn with zero items outside the season's
  transaction traffic. Expected, and ESPN's API covers both.
- **About 250 stored tweets predate the rich-tweet fields** and render with letter badges
  instead of avatars. They age out within a week of 2026-09-08.
