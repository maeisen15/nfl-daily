# Screenshots — seeing the app at iPhone size

`scripts/shots.mjs` renders the app in **WebKit** — the engine iOS Safari uses — at iPhone 15
Pro size and writes PNGs. It exists so a layout bug can be looked at instead of described, and
so an agent can check its own work without Matt photographing his phone.

WebKit specifically, not Chromium. The bugs this app actually gets are Safari bugs: text
escaping a quoted card, an image that renders too tall, `-webkit-line-clamp` clipping against
the wrong box because padding leaks through the clip. Chromium renders all three correctly,
which would make a Chromium screenshot worse than no screenshot.

## Running it

```bash
node scripts/shots.mjs all
```

That shoots every key screen against the live site. One screen at a time:

```bash
node scripts/shots.mjs tweets
node scripts/shots.mjs brief schedule
```

Screens are `tweets`, `tweet`, `articles`, `brief`, `schedule`, `standings`, `liked`,
`settings`, and `all`. The default with no argument is `tweets`.

PNGs land in `screenshots/`, which is gitignored — they are build artifacts, and a run
overwrites the ones before it. Each is 1179x2556, the real retina pixel size of the phone.

## Options

| Flag | What it does |
|---|---|
| `--local` | Serves `web/` on localhost:8000 and shoots that, for changes you haven't pushed |
| `--url <url>` | Shoots some other origin |
| `--scope <code>` | `BAL`, `national` or `rivals`. Default is the app's own |
| `--tweet <n\|id>` | Which post the detail view opens: a feed row number, or a tweet id |
| `--full` | The whole scrollable page rather than the visible screen |
| `--out <dir>` | Somewhere other than `screenshots/` |

`--local` is the one to use while working. It starts and stops its own server, so there is no
second terminal to manage:

```bash
node scripts/shots.mjs all --local
```

**The local port is 8000 and is not configurable.** The Worker's CORS allowlist
(`worker/wrangler.toml`) is exactly the live site and `http://localhost:8000`. From any other
port the tweet fetch is refused, and the app handles that *gracefully* — it falls back to the
tweets baked into `feed.json` and carries on looking normal. The script checks for this and
refuses to run rather than hand you a screenshot of yesterday's feed.

`--full` on the Tweets tab produces an image about 75,000px tall, because the feed is seven
days deep. It is useful on Brief, Schedule and a tweet detail; on the feed, shoot the viewport.

## When it fails

It is meant to. A run either produces a screenshot of the app with real data in it, or it exits
nonzero and writes nothing — a blank PNG does not look like a failure, it looks like a layout
bug, and acting on one costs more than having no harness.

It stops when the app fails to boot, when a screen's content never appears within 30 seconds,
when a tab renders its empty state, when a route 404s, when the page throws, and when the live
tweet fetch quietly fell back to baked data. The message says which. Failed loads of tweet
video and publisher thumbnails are reported as warnings and do not stop the run — several of
those hosts refuse hotlinked media by design, and the phone sees the same thing.

## What it won't catch

It is a faithful WebKit render, not an iPhone. Four differences are worth knowing:

- **No safe-area insets.** `env(safe-area-inset-*)` resolves to 0, so the notch and home
  indicator gaps that `app.css` reserves are missing. Anything anchored to the very top or
  bottom sits a few points off from where it does on the phone.
- **No installed-app chrome.** The viewport is set to the full 393x852 because Matt runs this
  from the home screen. In plain Safari the address and toolbars take about 190pt of that.
- **Nothing touch-driven.** Pull-to-refresh, swiping between scopes, the lightbox and the
  auto-hiding masthead all need real gestures. Screenshots catch layout, not interaction.
- **Liked is always empty.** Likes live in `localStorage`, and every run gets a clean browser.

## Installing

`playwright-core` is already in `package.json` as the repo's only dev dependency, pinned to
1.57.0 because that is the version whose WebKit build is already in
`~/Library/Caches/ms-playwright`. If `node_modules` is missing:

```bash
npm install
```

`playwright-core` deliberately, not `playwright` — it is the same API without the install step
that downloads a second copy of every browser. Nothing here is used by the app itself, which
still has no build step and no runtime dependencies.
