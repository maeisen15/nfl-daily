# Build plan — season features

Three groups, built and reviewed in order. The first is small and independent. The second
builds a data layer the third depends on.

## Group 1 — Accounts, Rivals, and cost

### The 19 new Ravens handles

Added to `team_coverage.primary.twitter_handles`, all routed to the Ravens tab, all in one
undifferentiated feed. No echo suppression: the same news arriving from six accounts is
tolerable and the collapse logic can be built later if it stops being tolerable.

    jamisonhensley   HoodieRamey      ryanmink        brianwacker1
    giana_jade       NflOgden         ravens4dummies  nikknowsball
    BarstoolBanks    jakelouque       TheMattWise     GarretSprints
    ChildsWalker     GarrettDowning   bsmolka         kylegoon
    BmoreBeatdown    sgellison        RussellStReport

`RavensSalaryCap` from the same list is already watched.

Every handle is resolved against twitterapi.io before it is added. A handle that does not
resolve is silently worthless — it contributes nothing forever and nothing ever says so, which
is how `nfl_com_news` went unnoticed for months.

### Rivals

The Steelers scope becomes **Rivals**: Steelers, Bengals, Browns, Chiefs, Bills in one tab,
one beat writer each, plus articles. One good beat writer carries most of what matters about a
team you check twice a week — who practiced, what the building feels like — and a second voice
mostly repeats the first.

Proposed writers, each verified before adding:

| Team | Handle | Outlet |
|---|---|---|
| Steelers | `FarabaughFB` (already watched) | PennLive |
| Bengals | `pauldehnerjr` | The Athletic |
| Browns | `MaryKayCabot` | cleveland.com |
| Chiefs | `ByNateTaylor` | The Athletic |
| Bills | `JoeBuscaglia` | The Athletic |

Articles: the three Steelers sources stay. The other four teams get sources as the right local
outlet is identified for each; the tab works without them in the meantime.

This is also the start of a **beat writer per team** table covering all 32. Five of them serve
this tab; the rest exist so the game-week dossier can pull the current opponent's writer
automatically once the schedule layer lands.

### The cost view

A read-only screen behind a masthead button, alongside the theme and Liked controls. It is not
a bottom tab — it answers a question asked monthly, not daily.

twitterapi.io publishes no billing API, so nothing can report the account balance. It does not
need to: the pricing is deterministic — $0.00015 per request, $0.15 per 1,000 tweets returned —
and the Worker knows exactly how many requests it made and how many tweets came back. Recording
that per poll produces the real charge, computed the same way the biller computes it.

Three things on the screen:

- **This month.** Spend to date and the pace it implies.
- **Per handle.** Every watched account, its tweet volume, and what it costs, sorted by cost.
  The shared per-request floor is divided evenly and labelled as such rather than hidden. This
  is the only view that says which of the new accounts are worth keeping.
- **Cadence.** What 1, 5, and 10-minute polling would each cost at the current tweet volume.
  The point of the screen is deciding cadence and account count, so it should answer that
  directly rather than leaving the arithmetic to the reader.

Source health moves here from the brief.

No spending cap. A cap's failure mode — the app going quiet mid-season without saying why — is
worse than the overspend it prevents on a ceiling of $10 against a realistic maximum near $5.

Cadence and the handle list stay in `config/sources.yaml`, changed deliberately rather than
from the phone. Writing settings from the app is a later decision, and the one that would let
something on the internet change what this app spends.

### Two fixes

Detail-view text drops from 23px to 17px. Twitter enlarges a focused tweet; at 23px it reads as
a different app.

Swipe follows the thumb. The gesture is currently measured only on release, so nothing moves
until you let go and anything under 60px is discarded — which is the whole of why it feels
delayed. The feed tracks the drag and snaps on release. Swipe moves between scopes only, never
between bottom tabs: one gesture with two meanings is predictable in neither.

## Group 2 — The schedule layer

One data layer, four features. The league's schedule and results answer "who plays whom, when,
on what channel, and what happened" — which is the schedule tab, the opponent the dossier is
about, the standings that give the Rivals tab context, and anything post-game.

Everything comes from ESPN's public API at no cost, through the existing dual-host failover in
`pipeline/fetchers/espn_api.py`; `site.api.espn.com` intermittently answers 403 behind Akamai
and `site.web.api.espn.com` serves the same payloads.

| Data | Endpoint |
|---|---|
| Week's games, scores, networks | `/apis/site/v2/sports/football/nfl/scoreboard?dates=` |
| A team's 17 games | `/apis/site/v2/sports/football/nfl/teams/<id>/schedule` |
| Standings | `/apis/v2/sports/football/nfl/standings` |
| Team stats with league ranks | `/apis/site/v2/sports/football/nfl/teams/<id>/statistics` |
| Team news | `/apis/site/v2/sports/football/nfl/news?team=<id>` |

### The tab

A fourth bottom tab: **Tweets · Articles · Schedule · Brief**. Scope-aware, so the top selector
keeps meaning something — Ravens opens their season, Rivals shows those five teams' games, NFL
the week's full slate. From any of them you can reach any week and any team.

- This week: every game, day, kickoff time, network, live score during, final after.
- Any week, forward and back, through the full season.
- Standings by division.
- Any team's full 17-game schedule and record.

Filters — primetime only, Sunday nights for the next month — wait. They are cheap to add and
easy to guess wrong, and a few weeks of use will say which ones matter.

**What cannot be built:** the TV distribution map. ESPN labels every Sunday afternoon game
"national," which is wrong for regional CBS and FOX windows, and the real source, 506sports,
blocks automated access and publishes maps as images. Announcer pairings are the same. Kickoff
times, networks, and primetime flags are all available; "which game is on in Baltimore" is not,
and a two-thirds-right answer about what you can watch is worse than none.

## Group 3 — The briefs

Three surfaces that stopped being one document with different inputs.

### NFL — a daily digest

Unchanged in kind and the version that earns its place: the feed is too large to read closely,
so a summary of the day's news, injuries, signings and developments is the way to stay current
without scrolling all of it.

Dates come off the bullets. `09/07: Falcons name Tua…` restates what the freshness stamp
already says.

### Rivals — the same digest, five teams

A short section per team. Enough to know what happened without opening the feed.

### Ravens — a game-week dossier

Not a summary of the day. A document that builds through the week and answers whether you are
ready for Sunday. Its shape changes by day: preview and matchup early, injuries accumulating
Wednesday through Friday, designations and weather by Saturday.

**Matchup.** Opponent, kickoff day and time, network, home or away, both records and standings.

**Statistics**, side by side, away team left and home team right. Points per game and rank,
total yards and rank, passing and rushing yards and rank — and the same three for the defense,
from ESPN's own/opponent split. Ranks are the readable part: 4th against 28th says more at a
glance than two yardage figures. Extremes are marked so a lopsided matchup is visible without
reading the table.

**Injuries, both teams.** The grid from the Ravens' own graphic: player, position, injury,
practice participation by day, game status. Built from NFL.com's injury report, which publishes
a server-rendered table per team with exactly these columns.

Two reasons to build it rather than show the Ravens' image. It covers all 32 teams, so the
opponent gets the same treatment — and the opponent's report is the half you cannot get today.
And the Ravens post a picture, which carries no data at all.

NFL.com shows only the most recent practice day, so each day's snapshot is stored and the
Wednesday–Friday grid assembled from the history. This also repairs `nfl_com_injuries`, which
has been returning nothing.

**Weather.** Kickoff temperature, wind, and precipitation, from Open-Meteo — no key, no
account, no cost — against a static table of the 32 stadiums. Domes say so. The forecast
appears only when it means something, a few days out.

**Opponent news.** ESPN's team news feed plus that week's beat writer, pulled automatically
from the beat-writer table once the schedule says who the opponent is.

**Previews and takes.** Game-preview articles from sources already collected.

Two things deliberately left out. A generated "keys to the game" section is the app having
opinions instead of reporting, and reads as filler. A post-game recap waits until the dossier
has been used — Monday's version of this same screen, showing the final and the reaction, may
turn out to be all that is wanted.

Outside the season the dossier falls back to a daily Ravens summary.

## Storage

Injury snapshots have to survive between pipeline runs to become a Wednesday-to-Friday grid,
and the hourly job deploys without committing. They go in **D1**, alongside the tweets: it is
already durable, already has migrations, and the pipeline already has an authenticated path to
the Worker. Schedule, standings and statistics are rebuilt from ESPN each run and need no
history, so they stay in `web/data/`.

## Cost

Handles go from 17 to about 40. Twenty-one fit in one twitterapi.io search query, so this is
two queries per poll rather than one, and the second query is the larger part of the increase.

    now       17 handles, 1 query      ~$1.65/month
    after     40 handles, 2 queries    ~$3.60/month

The next threshold is handle 43, where a third query adds about $1.09/month. Everything in
Groups 2 and 3 — ESPN, NFL.com, Open-Meteo — is free.

New hosts for `docs/network-allowlist.txt` and the cloud routine's allowlist:
`site.web.api.espn.com`, `api.open-meteo.com`.

## Not in this batch

- **Settings written from the app** — adding, removing and muting accounts, and changing
  cadence, from the phone. Wanted, but it is the first write path from the internet into
  something that costs money, and deserves its own decision.
- **Echo suppression** — collapsing the same story from several accounts.
- **Search** over stored tweets.
- **Schedule filters** — primetime, Sunday nights, by week.
- **A post-game package.**
- **Where you left off** — a mark in the feed, and the "what you missed" brief it would enable.
- **Keyword muting** — sponsored posts and ad reads.
