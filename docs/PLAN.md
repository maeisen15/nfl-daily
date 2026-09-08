# NFL Daily — Product Plan

A private Twitter client for a curated list of NFL accounts, plus the article and briefing
surfaces that hang off it. One user, one iPhone, installed to the home screen.

## What this app is for

Matt has consumed NFL news through Twitter for years: scroll a curated set of accounts in
chronological order, read the takes, click through to articles. The problem is Twitter itself —
an engagement machine that keeps pushing content outside the topics he wants. This app is the
part of Twitter he actually uses, with none of the part he doesn't.

That framing decides most design arguments. **The Tweets tab is the product.** Articles are the
secondary surface. The daily briefing is a convenience that has to earn its place.

The app should feel like Twitter. Not "inspired by" — the same information design, the same
gestures, the same density. Where a decision is ambiguous, do what Twitter does.

## Navigation

Three tabs along the bottom, in this order:

1. **Tweets** — the default tab. The app opens here.
2. **Articles**
3. **Home** — the daily briefing.

Scope tabs sit at the top, styled and behaving like Twitter's list tabs: **Ravens · NFL ·
Steelers**, swipeable left/right, with the active scope's accent color underlining it. Ravens
is the default.

## Tweets

The primary surface. A chronological feed of tweets from the accounts in `config/sources.yaml`,
scoped by the top tabs, newest first, going back seven days.

### The tweet row

Twitter's layout: a 40px avatar in a left column, content in a right column.

```
[avatar]  Jeff Zrebiec  @jeffzrebiec · 2h
          Jesse Minter announces that Jovaughn Gwyn will start
          at center for Ravens in Week 1.
          [media]
          [quoted tweet card]
          [link preview card]
          💬 3    🔁 10    ♥ 314    ıl 14K              𝕏
```

Rows are separated by a hairline, not boxed. No card borders, no inset surfaces — the row uses
the full width, which is where the density comes from.

Rules:

- **Names render in the body sans face, normal case.** No condensed display font in content.
  Outlet suffixes like `(The Athletic)` are stripped from display names everywhere.
- **The name row never wraps.** Name and handle truncate with an ellipsis; the timestamp is
  pinned and always visible.
- **Text clamps at 8 lines** with an inline "Show more" that expands in place.
- **Media** renders below the text at full column width. Tapping opens a full-screen,
  pinch-zoomable viewer. Video is tap-to-play; GIFs autoplay muted and loop.

### Retweets

A retweet renders as the **original** tweet, with a small gray line above the row:

```
🔁 Jonas Shaffer reposted
[avatar]  Baltimore Banner Sports  @AllBannerSports · 3h
          Ravens name Jovaughn Gwyn starting center for Week 1
```

The full original text, the original author's avatar and engagement counts. Never the truncated
`RT @handle: …` string.

### Quoted tweets

A bordered, rounded card nested inside the row, carrying the quoted author's avatar, name,
handle, timestamp, and text. When the quoted tweet has an image, it renders as a small square
thumbnail to the left of the text rather than a full-width image.

**The card is tappable** and opens that tweet's own detail view.

### Threads

Consecutive tweets from the same author in the same thread are grouped as one feed item:

- **Up to 3 tweets** render inline as connected rows, with the vertical gray line running down
  the avatar column between them.
- **Longer threads** show the first two rows plus `Show this thread (5)`, which opens the
  detail view.

A thread counts as one item in the feed regardless of length.

### Link preview cards

When a tweet links to an article, the destination's `og:image` and `og:title` render as a card
below the text — image, headline, and the domain underneath — tappable to the article. This is
a primary way articles get found, so it matters as much as anything else in the feed.

### Engagement row

Reply, retweet, like, and view counts, plus an X icon at the right that opens the tweet on
x.com. Counts are captured when the tweet is fetched and never updated afterward — a frozen
snapshot is fine and costs nothing.

The **heart is the only interactive control**. Tapping it fills it and saves the tweet locally.

### Likes

Liking is a local gesture. Nothing is sent to Twitter, nothing is public.

A liked tweet is copied in full — text, author, media, quoted post — into the browser's
`localStorage`, so it survives the seven-day prune on the server. Storage lives on the phone
inside Safari's storage for this site: no server, no account, no cost, and no size concern
(a tweet is about 1KB against a ~5MB allowance).

A **Liked** view lists them newest-first, reachable from the Tweets tab. It doubles as
save-for-later.

The like store sits behind a small interface so it can move to the Worker's D1 later without
touching the views.

### Refresh

Three mechanisms, all pointing at the same fetch:

- **Pull-to-refresh** at the top of the feed.
- **Background poll every 60 seconds** while the app is open and visible.
- **A "N new tweets" pill** that appears at the top when new tweets arrive. New tweets are held
  out of the feed until the pill is tapped, so the list never shifts under a thumb mid-read.

The ceiling is the Worker's own five-minute poll of twitterapi.io; nothing new exists between
those.

### Tweet detail view

Tapping anywhere on a tweet row opens it at `#/tweet/<id>`:

- The tweet, larger, with full text and media.
- Its quoted tweet, tappable into its own detail view.
- The full thread below it, connected, when it's part of one.
- The engagement row, with the X link.
- A back control that returns to **the exact scroll position** in the feed.

Scroll position is preserved on every navigation, including tab switches and scope changes.

## Articles

A scannable list, not a firehose.

### The article row

Thumbnail on the left, text on the right:

```
[img]  Cowboys Pro Bowl guard Smith headed for IR
       Cowboys starting left guard Tyler Smith will undergo thumb…
       ESPN · 2h
```

Images come from the RSS feed where it carries one, otherwise from the article's `og:image` —
the same fetching machinery as tweet link cards. When there is genuinely no image, the row
renders as an intentional text row rather than leaving a gray box.

The one-line snippet stays; it is real signal at a glance.

### Deduplication

The same story from ESPN, CBS, and FOX collapses to a single row. The highest-ranked source
wins and the others disappear silently — no "also covered by" line.

Clustering is tuned **conservative**: when two articles are only probably the same story, show
both. A missed merge is invisible; a wrong merge hides an article.

### Ordering

One card layout, one sort function, a per-scope weighting:

- **Ravens** sorts by source tier, then recency. Tier order: The Athletic, The Banner, Baltimore
  Sun, Russell Street Report, Ravens official.
- **NFL and rivals** sort by cluster size, then recency. Cluster size is the importance signal —
  a story three outlets ran matters more than one nobody else picked up.

In both cases **day boundaries win**: articles group by day, newest day first, and the scope's
weighting orders items within a day. A two-day-old piece never sits above today's news.

## Home

The daily briefing, restyled to match and cut down. Per scope: **Summary, Transactions,
Injuries.** Source Health is removed from the output entirely — it is diagnostics, and it
belongs in the run log.

Cadence, prompt, and grounding rules are unchanged.

## Design system

Twitter's information design throughout, on a light default.

- **Type:** the system sans face for all content. Barlow Condensed survives only in the
  "NFL DAILY" wordmark.
- **Themes:** Light (white), Dim (navy-slate), Dark (near-black) — Twitter's three. Light is
  the default; the toggle cycles.
- **Color:** neutral grays, not purple-tinted. The per-scope accent color is retained and used
  only for the active scope tab, the active bottom tab, and links.
- **Structure:** hairline separators between rows, full-bleed content, no boxed cards except
  where Twitter itself uses one — quoted tweets and link previews.
- **Density:** matching Twitter's line-height and padding, which fits roughly 2.5 tweets per
  screen where the current design fits 1.5.

## Data model

The Worker already receives everything below from twitterapi.io and discards most of it.
Capturing it needs new columns on `tweets`, a new table, and changes to `normalize()`.

New per-tweet fields:

| Field | Purpose |
|---|---|
| `author_avatar` | `author.profilePicture` — the left column of every row |
| `retweeted` | the full `retweeted_tweet` object, stored like `quoted` already is |
| `conversation_id`, `reply_to_id` | thread grouping and ordering |
| `like_count`, `retweet_count`, `reply_count`, `view_count` | the engagement row |
| `links` | `entities.urls[].expanded_url`, the input to link preview cards |

A `link_cards` table caches `url → {title, image, domain}`, populated by fetching the
destination's Open Graph tags once at ingest. Cloudflare's outbound fetches are free, so this
costs nothing per link beyond the first.

Retention stays at **seven days**. The app requests the full seven rather than the current 48
hours, and `GET /tweets` gains cursor pagination so infinite scroll isn't capped by the 500-row
limit.

Replies to accounts other than the author's own thread stay excluded. Showing a reply without
its parent is confusing, and fetching parents costs 15 credits each.

Old rows keep their existing fields and render without avatars or counts until they age out.
The store is fully populated within seven days of the Worker deploying.

## Front-end architecture

`web/` is rebuilt from scratch. Vanilla JavaScript, no framework, no build step — the
dependency is the durability risk in a project like this, not the code. Four separated concerns:

```
web/
  index.html
  app.css              design tokens + component styles
  js/
    data.js            fetching, caching, pagination, offline fallback
    store.js           app state: scope, tab, route, feed, likes
    router.js          hash routes: #/tweets, #/tweet/<id>, #/liked, #/articles, #/home
    views/
      feed.js          the tweet feed
      tweet.js         one tweet row (shared by feed, thread, detail)
      detail.js        tweet detail view
      articles.js      article list
      home.js          the briefing
      chrome.js        masthead, scope tabs, bottom tabs
    lib/
      likes.js         the like store behind a swappable interface
      time.js, dom.js  formatting and element helpers
  sw.js                offline: last feed stays readable with no signal
```

View functions take data and return DOM elements. No `innerHTML` string concatenation, which is
both the current XSS surface and the reason the layout is hard to reason about.

## Build order

**Worker and data first**, deployed immediately — the current app ignores fields it doesn't
know about, so the store starts filling with avatars, real retweets, threads, and engagement
counts while the front-end is still being built.

1. **Data layer.** Worker schema and `normalize()` changes; `link_cards` table and Open Graph
   fetching; cursor pagination on `GET /tweets`; podcasts removed from `sources.yaml`; article
   images extracted in the fetchers; article clustering and per-scope ordering in `publish.py`;
   Source Health dropped from the digest prompt.
2. **Front-end.** The rebuild: design system, tweet rows with avatars and engagement, retweets,
   quoted tweets, threads, link cards, detail view and routing, scroll restoration, likes and
   the Liked view, refresh mechanics, the article list, the restyled briefing, offline.
3. **Search.** Full-text search over stored tweets, using D1's FTS. No API calls, no cost.

Everything is previewed locally against live data before anything reaches the phone. The live
app is untouched until the rebuild is complete.

## Deferred

Not gaps — decisions to revisit once the daily-driver experience is right.

- **Scores and schedule** — a thin band showing the next Ravens game or the live score. First
  thing after the core rebuild.
- **Gameday mode** — pregame tunnel and warmup content, live injury updates, post-game video
  and articles. Worth designing properly; the Ravens game itself is watched elsewhere.
- **Rivals** — whether Steelers stays its own scope or rivals collapse into the NFL scope with
  one beat writer each. Decide after living with the new feed.
- **More handles** — the list is a decision for Matt. Cost: handles 18–21 are free, each
  further block of 21 adds about $1.09/month, and each handle's own tweets run about $0.07/month.
  Roughly 60 handles lands near $4.50/month against a $5–10 ceiling.
- **Likes in D1** — durable and cross-device, if losing local likes ever matters.
- **"What you missed" briefing** — a digest generated against unseen tweets rather than a fixed
  24-hour window. Only meaningful once unread state exists.
- **Replies to other accounts** — needs parent-tweet fetching to be worth showing.
- **Push notifications** — declined.
