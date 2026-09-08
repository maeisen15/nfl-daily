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

Four tabs along the bottom: **Tweets** (the default — the app opens here), **Articles**,
**Brief**, **Schedule**.

Scope tabs sit at the top, styled and behaving like Twitter's list tabs: **Ravens · NFL ·
Rivals**, with the active scope's accent underlining it. Ravens is the default. Both choices
persist. Swiping between scopes follows the thumb and snaps on release; it never moves between
bottom tabs, because one gesture with two meanings is predictable in neither.

A gear in the masthead opens **Usage** — spending, per-account cost, and source health. It
answers a question asked monthly, not a place you go, which is why it is not a tab.

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

## Rivals

Steelers, Bengals, Browns, Chiefs and Bills share one scope. Five tabs for teams checked twice
a week would be five near-empty rooms; the point is keeping half an eye on all of them at once.

One beat writer each, plus articles where a local outlet publishes a usable feed. One good beat
writer carries most of what matters about a team you check twice a week — who practised, what
the building feels like — and a second voice mostly repeats the first. Kansas City and
Cincinnati use SB Nation sites because the Star stalls automated requests and the Enquirer
retired its feeds.

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

## Schedule

The league's schedule and results, from ESPN's public API at no cost. Scope-aware, so the top
selector keeps meaning something: a team scope opens on that team's season, because week paging
would make you hunt for the one game that matters; NFL and Rivals open on the week, where the
week is the unit.

Every game with kickoff time, network, venue, records, live score during and final after; any
week forward and back through the playoffs; standings by division; any team's full season.

**The TV distribution map is not buildable.** ESPN labels every Sunday afternoon game
"national", which is wrong for regional CBS and FOX windows, and 506sports blocks automated
access and publishes its maps as images. A two-thirds-right answer about which game you can
watch is worse than none.

## Brief

Three documents, not one with different inputs.

**NFL** is a daily digest — Summary, Transactions, Injuries. The feed is too large to read
closely, so this is how the league stays legible without scrolling all of it. The version that
earns its place.

**Rivals** is the same three sections shared across all five teams, ordered by importance rather
than by team, each bullet naming its own.

**Ravens** is a game-week dossier followed by a single **Key news** section. No written
injuries: the practice report above is built from official filings and is always more current,
so a written one would be a worse copy of something already read. A transaction that matters is
news and belongs in Key news.

Bullets carry no date prefix — everything is from the last day and the brief is stamped with
when it was written.

### The game-week dossier

Not a summary of the day. It answers whether you are ready for Sunday, and fills in as the week
goes. In order: the matchup, articles about this specific game, the practice report, the
opponent's beat writer, the statistical comparison, the forecast.

Almost none of it is written. A model summarising a table of practice participation only adds a
way for it to be wrong.

- **Injuries** are the grid the team posts as a graphic — player, position, injury, a column per
  practice day, then the designation. NFL.com publishes only the most recent day, so each day is
  snapshotted and the week assembled from the history. Bounded to one game week: an eight-day
  window would put last Wednesday's column beside this one. Before the first filing it says so,
  and names the day, read on the league's calendar rather than the phone's.
- **Statistics** put the away team left and the home team right, offence then defence, with
  league ranks. Ranks are computed here: ESPN fills in `rank` for what a team allows and leaves
  it null for what a team produces, so its own numbers would give ranked defence and blank
  offence.
- **The opponent's beat writer** appears in a box you scroll inside, so the rest of the dossier
  stays a thumb away. The writer for each of the 32 teams is listed in config, and only the
  upcoming opponent's is polled — under a scope no tab filters on, so their week feeds the
  dossier without appearing in a feed. It rotates itself from the schedule.
- **Weather** at kickoff from Open-Meteo, against a table of the 32 stadiums. Domes say so;
  a retractable roof still gets a forecast. A neutral site names the venue instead — no
  coordinate table covers where the league goes next.
- **Previews** are articles already collected that name the opponent. Selected that way rather
  than by looking for the word "preview": a beat writer's piece on the matchup rarely calls
  itself one.

## Usage

What the polling actually costs, so adding a handle or changing the cadence is decided against
real numbers. twitterapi.io publishes no billing API and no cost header, so this is computed —
$0.00015 per request, $0.15 per thousand tweets returned. The store keeps requests and tweets
rather than dollars, so correcting a price re-prices the whole history.

The month and its pace, then every account and what it cost, then what 1, 5, 10 and 15-minute
polling would each cost at the volume actually seen. Source health lives here too.

No spending cap: the app going quiet mid-season is a worse failure than the overspend it would
prevent.

## Design system

Twitter's information design on a light default. System sans for all content; Barlow Condensed
survives only in the wordmark. Three themes — Light, Dim, Dark — cycled by the masthead button.
Neutral grays, not tinted; the per-scope accent appears only on the active scope tab, the
active bottom tab, and links. Hairline separators, full-bleed content, boxed cards only where
Twitter uses one: quoted tweets and link previews.

## Architecture

```
worker/          Cloudflare Worker + D1. Polls twitterapi.io; serves /tweets, /usage,
                 /injuries, /health. Deployed by hand: `npx wrangler deploy`.
  migrations/    D1 schema changes, applied with `wrangler d1 execute --remote --file=`
pipeline/        orchestrator.py  articles and structured data, hourly
                 publish.py       clusters and writes web/data/*.json
                 schedule.py      season, scores, standings
                 injuries.py      a daily practice-report snapshot into D1
                 gameweek.py      the dossier
                 tweets.py        handle sync and manual backfill
                 data/stadiums.py coordinates and roof type, for the forecast
scripts/         verify_handles, fetch_source_icons, fetch_team_logos,
                 check_allowlist, verify_deploy
web/
  js/
    data.js      fetching, caching, pagination, offline fallback
    store.js     app state: scope, route, feed, pending, likes
    router.js    hash routes: #/tweets, #/tweet/<id>, #/liked, #/articles,
                 #/schedule, #/brief, #/settings
    views/       feed, tweet, detail, articles, schedule, brief, dossier,
                 settings, liked, lightbox, chrome
    lib/         dom, icons, time, likes
  sw.js          data network-first; shell stale-while-revalidate
```

Vanilla JavaScript, no framework, no build step — in a project like this the dependency is the
durability risk, not the code. View functions take data and return DOM elements; nothing
concatenates HTML, which is why text from other people can't become markup.

The service worker serves the shell **stale-while-revalidate**. Cache-first pinned the app to
whatever it had stored and made every deploy invisible until a version string changed by hand.
The consequence worth knowing: a change lands on the second open, not the first.

Everything on the server keeps time in **Eastern** — the poll's waking hours, the day a cost or
a practice report belongs to, the day the first injury report is filed. Those follow the
league's calendar and must not move when the phone does. Clock times in the app are local,
because they answer when to be in front of a television.

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

**A Twitter handle:** add it to `config/sources.yaml`, run `python3 scripts/verify_handles.py`,
then `python3 pipeline/tweets.py --mode sync-handles`. The Worker builds its poll query from
that table, so the YAML alone does nothing. Verify first: a misspelled handle is accepted by
the query, returns nothing forever, and is reported by nothing. `--only` backfills just the new
one, for a fraction of a full sweep.

**A rival team:** add it under `team_coverage.rivals` with a beat writer, and its team code
reaches the schedule tab through `config.json` without a code change.

Handle cost: 21 fit in one search query, each further block of 21 adds about $1.09/month, and
each handle's own tweets run about $0.07/month. Forty-one handles is about $3.60/month against
a $5–10 ceiling; the next threshold is 43. **Money is not the constraint; attention is.** Be
generous with Ravens handles and picky with national ones — thirty accounts echoing the same
Schefter post is the noise this app exists to escape.

**The beat-writer table needs a human glance each preseason.** `verify_handles.py` proves an
account exists, not that the person still works that beat.

## Not built yet

- **Settings written from the app** — adding, removing and muting accounts, and changing the
  cadence, from the phone. Wanted, but it is the first write path from the internet into
  something that costs money, and deserves its own decision. Muting is the piece worth having
  first, and it can be device-local like likes.
- **Search** over stored tweets, using D1's full-text index. No API calls, no cost.
- **Echo suppression** — the same story from several accounts collapsing to one row. Declined
  for now; reading it twice is easy to scroll past.
- **Where you left off** — a mark in the feed, and the "what you missed" brief it would enable.
- **Keyword muting** — sponsored posts and ad reads.
- **Schedule filters** — primetime only, Sunday nights for the next month.
- **A post-game package** — the dossier's Monday form, showing the final and the reaction.
- **Gameday mode** — live in-game behaviour. Declined in spirit: during the game the game is
  being watched, and Twitter-during-a-game is the habit this app exists to escape.
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
- **The TV map** cannot be built; see Schedule.
