#!/usr/bin/env node
/* Screenshots of the app in real WebKit at iPhone size, so a layout bug can be looked at
 * instead of described.
 *
 * The bugs that keep biting this app are Safari-at-phone-width bugs: text escaping a quoted
 * card, an image that renders too tall, `-webkit-line-clamp` clipping against the wrong box
 * because padding leaks through the clip. Chromium does not reproduce any of them, so this
 * launches WebKit — the same engine iOS Safari uses — and nothing else.
 *
 * Usage is in docs/SCREENSHOTS.md. The short version:
 *
 *   node scripts/shots.mjs all               every key screen, live site
 *   node scripts/shots.mjs tweets --local    the feed, from web/ on localhost:8000
 *   node scripts/shots.mjs tweet --full      the first tweet's detail view, whole page
 *
 * The one rule this file exists to keep: never write a PNG of a screen that didn't render.
 * A blank screenshot does not look like a failure — it looks like a layout bug — and acting
 * on one costs more than having no harness at all. So every screen waits on a selector that
 * only appears once real data is on screen, and anything short of that exits nonzero.
 */

import { webkit, devices } from "playwright-core";
import { createServer } from "node:http";
import { readFile, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const LIVE_URL = "https://maeisen15.github.io/nfl-daily/";

/* The Worker's CORS allowlist is exactly "https://maeisen15.github.io,http://localhost:8000"
 * (worker/wrangler.toml). Serving the local copy on any other port, or on 127.0.0.1 instead of
 * localhost, means the tweet fetch is refused by the browser — and the app handles that
 * gracefully by falling back to the tweets baked into feed.json, so the feed still looks
 * populated and the screenshot still looks fine. That is the silent failure this harness is
 * supposed to prevent, so the port is fixed rather than configurable. */
const LOCAL_PORT = 8000;
const LOCAL_URL = `http://localhost:${LOCAL_PORT}/`;

/* iPhone 15 Pro. Playwright's own descriptor is used for the user agent, scale factor and
 * touch flags, but its viewport is 393x659 — Safari's visible area once the address bar and
 * toolbar are taken out. Matt runs this installed to the home screen, where there is no
 * browser chrome and the page gets all 852 points, so the viewport is overridden to the full
 * screen height. That difference is most of a tab bar's worth of layout. */
const DEVICE = devices["iPhone 15 Pro"];
const VIEWPORT = { width: 393, height: 852 };

/* What counts as rendered, per screen.
 *
 * `ready` is deliberately a content selector and never a container: every view renders its
 * wrapper synchronously and fills it in later, so waiting on the wrapper would wait for
 * nothing. config.json, feed.json, digest.json and gameweek.json are fetched before the first
 * paint, the tweets come from the Worker after it, and schedule.json is fetched only when the
 * Schedule tab is first opened — which is why each of these waits on its own evidence rather
 * than on a load event or a sleep.
 *
 * `allowEmpty` marks the two screens whose empty state is a legitimate thing to photograph:
 * nothing has been liked, or there is no usage to report yet. Everywhere else an empty state
 * is a failure. */
const SCREENS = {
  tweets: {
    label: "Tweets feed",
    hash: "#/tweets",
    ready: ".feed article.tweet",
  },
  articles: {
    label: "Articles",
    hash: "#/articles",
    ready: ".article-title",
  },
  brief: {
    label: "Brief",
    hash: "#/brief",
    // The dossier leads the Ravens brief; the written digest is the rest of it. Either one
    // arriving means the tab drew.
    ready: ".digest-section, .dossier",
  },
  schedule: {
    label: "Schedule",
    hash: "#/schedule",
    // A single-team scope opens on that team's season, the league scopes on the week, and the
    // two build different rows.
    ready: ".sched-fixture, .sched-teams",
  },
  standings: {
    label: "Standings",
    hash: "#/schedule?view=standings",
    ready: ".standings-row",
  },
  liked: {
    label: "Liked posts",
    hash: "#/liked",
    ready: "article.tweet, .empty",
    allowEmpty: true,
  },
  settings: {
    label: "Usage and settings",
    hash: "#/settings",
    ready: ".settings-section, .settings-body .empty",
    allowEmpty: true,
  },
  tweet: {
    label: "Tweet detail",
    // A detail view can only draw a tweet the feed has already loaded, so this one starts on
    // the feed and opens a row from it.
    hash: "#/tweets",
    ready: ".feed article.tweet",
    detail: true,
  },
};

/* Everything worth looking at after a change, in the order it is worth looking at it. */
const ALL = ["tweets", "tweet", "articles", "brief", "schedule", "standings", "liked", "settings"];

const READY_TIMEOUT_MS = 30_000;

main().catch((err) => {
  fail(err && err.message ? err.message : String(err));
});

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const server = opts.local ? await startServer() : null;
  const base = opts.url || (opts.local ? LOCAL_URL : LIVE_URL);
  const outDir = opts.out;
  await mkdir(outDir, { recursive: true });

  console.log(`WebKit ${webkit.name()} · ${VIEWPORT.width}x${VIEWPORT.height} @${DEVICE.deviceScaleFactor}x`);
  const origin = opts.local ? "local server" : opts.url ? "custom --url" : "live site";
  console.log(`source   ${base}  (${origin})`);
  console.log(`scope    ${opts.scope || "app default"}`);
  console.log(`out      ${outDir}`);
  console.log("");

  const browser = await webkit.launch();
  const written = [];
  try {
    const context = await browser.newContext({
      ...DEVICE,
      viewport: VIEWPORT,
      // The app prints day labels and kickoff times with toLocaleString, so without these the
      // screenshots would be timestamped in whatever the machine happens to be set to rather
      // than in the timezone the reader is in.
      locale: "en-US",
      timezoneId: "America/New_York",
    });
    const page = await context.newPage();
    const watch = watchForBreakage(page);

    await boot(page, base, opts, watch);

    for (const name of opts.screens) {
      written.push(await capture(page, name, opts, watch));
    }

    watch.reportWarnings();
  } finally {
    await browser.close();
    if (server) await closeServer(server);
  }

  console.log("");
  for (const shot of written) {
    console.log(`${shot.file}  ${shot.width}x${shot.height}  ${kb(shot.bytes)}`);
  }
}

/* ---------- boot ---------- */

/* The first load is the expensive one and the only one that can fail interestingly, so it is
 * done once and then every screen is reached by hash navigation — which is also how the app is
 * actually used, and keeps the loaded tweets in the store where the detail view needs them. */
async function boot(page, base, opts, watch) {
  const url = new URL(base);
  // Scope is read from the query string at boot, not from the hash, so it has to be here.
  if (opts.scope) url.searchParams.set("scope", opts.scope);
  // Always open on the feed, whatever was asked for. Tweets are fetched once at boot into a
  // store every other screen reads from, so this is where it can be checked that they actually
  // arrived — and the detail view has nothing to open until they have.
  url.hash = "#/tweets";

  const res = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
  if (res && res.status() >= 400) {
    throw new Error(`${url} returned HTTP ${res.status()}. Wrong --url, or the page isn't deployed.`);
  }

  // The boot failure path replaces the whole view with one message, and it is the difference
  // between "the app is broken" and "this one tab is empty" — so it is checked before anything
  // waits on a selector that is never going to appear.
  await page.waitForSelector("#main > *", { timeout: READY_TIMEOUT_MS }).catch(() => {});
  const bootError = await page.evaluate(() => {
    const empty = document.querySelector("#main > .empty");
    return empty && /couldn't load/i.test(empty.textContent) ? empty.textContent.trim() : null;
  });
  if (bootError) {
    throw new Error(`The app failed to boot: "${bootError}"\n` +
      `  data/*.json did not load. ${watch.describeFailures()}`);
  }

  if (opts.scope) {
    const active = await page.evaluate(() => document.documentElement.dataset.scope);
    if (active !== opts.scope) {
      throw new Error(`--scope ${opts.scope} was ignored; the app is showing "${active}". ` +
        `Valid codes come from web/data/config.json (BAL, national, rivals).`);
    }
  }

  await requireLiveTweets(page);
  watch.check();
}

/* The trap this check exists for: when the Worker refuses the tweet fetch, the app does not
 * break. It falls back to the tweets baked into feed.json by the hourly run, draws a perfectly
 * normal-looking feed, and says "Offline" in the masthead in small grey text. A screenshot of
 * that is a screenshot of hours-old data that looks exactly like current data.
 *
 * The usual cause is the origin: the Worker's allowlist is only the live site and
 * http://localhost:8000, so a local copy served from any other port or from 127.0.0.1 lands
 * here. */
async function requireLiveTweets(page) {
  await page.waitForSelector(".feed article.tweet, .feed .empty", {
    state: "visible", timeout: READY_TIMEOUT_MS,
  }).catch(() => {
    throw new Error(`The feed never drew anything at all within ${READY_TIMEOUT_MS / 1000}s.`);
  });

  // The status text is written when the first page of tweets resolves, one way or the other.
  await page.waitForFunction(
    () => document.querySelector(".feed article.tweet") || document.getElementById("status").textContent,
    null, { timeout: READY_TIMEOUT_MS },
  ).catch(() => {});

  const offline = await page.evaluate(() => document.getElementById("status").textContent.trim());
  if (offline) {
    throw new Error(
      `The app is showing "${offline}" — the live tweet fetch failed, so the feed is falling back\n` +
      `  to whatever feed.json was baked with. Those screenshots would be of stale data.\n` +
      `  Check the Worker is up, and that the origin is the live site or http://localhost:${LOCAL_PORT}\n` +
      `  exactly — worker/wrangler.toml ALLOWED_ORIGINS is the whole list.`);
  }
}

/* ---------- one screen ---------- */

async function capture(page, name, opts, watch) {
  const screen = SCREENS[name];
  const url = new URL(page.url());
  url.hash = screen.hash;

  // Same-document navigation: assigning the hash fires hashchange, which is what the router
  // listens to. A goto() would reload and re-pay the whole boot.
  if (page.url() !== url.toString()) {
    await page.evaluate((h) => { window.location.hash = h; }, screen.hash);
  }
  await page.evaluate(() => window.scrollTo(0, 0));

  await waitForRendered(page, name, screen);

  if (screen.detail) await openDetail(page, opts.tweet);

  await settle(page);

  const label = screen.detail ? `tweet-${String(opts.tweet)}` : name;
  const parts = ["shot", label];
  if (opts.scope) parts.push(opts.scope);
  if (opts.full) parts.push("full");
  const file = path.join(opts.out, `${parts.join("-")}.png`);

  await page.screenshot({ path: file, fullPage: opts.full });

  const { size } = await stat(file);
  const dims = await page.evaluate(() => ({
    width: Math.round(window.innerWidth * window.devicePixelRatio),
    height: Math.round((document.documentElement.scrollHeight) * window.devicePixelRatio),
  }));
  const width = VIEWPORT.width * DEVICE.deviceScaleFactor;
  const height = opts.full ? dims.height : VIEWPORT.height * DEVICE.deviceScaleFactor;

  console.log(`ok  ${screen.label}`);
  return { file, bytes: size, width, height };
}

/* The whole point of the harness. A view that drew its wrapper and nothing else, or drew an
 * empty state, must not be photographed and called a screenshot of the app. */
async function waitForRendered(page, name, screen) {
  try {
    await page.waitForSelector(screen.ready, { state: "visible", timeout: READY_TIMEOUT_MS });
  } catch {
    const seen = await page.evaluate(() => ({
      nodes: document.querySelectorAll("#main *").length,
      text: (document.getElementById("main").textContent || "").trim().slice(0, 240),
    }));
    throw new Error(
      `${screen.label} never rendered. Waited ${READY_TIMEOUT_MS / 1000}s for "${screen.ready}".\n` +
      `  #main holds ${seen.nodes} nodes and reads: ${seen.text || "(nothing)"}`);
  }

  const empty = await page.evaluate(() => {
    const node = document.querySelector("#main .empty, #main .sched-empty");
    return node ? node.textContent.trim() : null;
  });

  if (screen.allowEmpty) {
    // Nothing liked yet, or no usage to report, is a real state of the app and worth a picture.
    // Say so, so that an empty-looking PNG is never mistaken for a broken one.
    if (empty) console.log(`    (empty by design: "${empty}")`);
    return;
  }

  if (empty) {
    throw new Error(`${screen.label} rendered its empty state: "${empty}"\n` +
      `  There is no layout to look at here. Fix the data before trusting a screenshot.`);
  }

  // Cheap backstop against a screen that satisfies its selector but is otherwise bare.
  const nodes = await page.evaluate(() => document.querySelectorAll("#main *").length);
  if (nodes < 8) {
    throw new Error(`${screen.label} rendered only ${nodes} elements. That is a skeleton, not a screen.`);
  }
}

/* Open a tweet's detail view.
 *
 * A snowflake id goes straight down the route, which is the shareable-URL path. An index
 * instead clicks the nth row of the feed, because a tweet row carries its id only in a click
 * handler's closure — there is no attribute to read it off — and clicking is the real path
 * anyway. The click is dispatched on the <article> itself so that the row's own handler sees
 * it: the handler ignores clicks that land on a link, a button, a video or a quoted card. */
async function openDetail(page, wanted) {
  const asId = /^\d{10,}$/.test(String(wanted));

  if (asId) {
    await page.evaluate((id) => { window.location.hash = `#/tweet/${id}`; }, String(wanted));
  } else {
    const index = Number(wanted);
    const count = await page.locator(".feed article.tweet").count();
    if (!Number.isInteger(index) || index < 1) {
      throw new Error(`--tweet wants a row number (1, 2, 3…) or a tweet id; got "${wanted}".`);
    }
    if (index > count) {
      throw new Error(`--tweet ${index} but the feed only loaded ${count} rows.`);
    }
    await page.evaluate((i) => {
      document.querySelectorAll(".feed article.tweet")[i - 1].click();
    }, index);
  }

  try {
    await page.waitForSelector(".detail", { state: "visible", timeout: 10_000 });
  } catch {
    const empty = await page.evaluate(() => {
      const node = document.querySelector("#main .empty");
      return node ? node.textContent.trim() : null;
    });
    throw new Error(empty
      ? `Tweet detail did not open: "${empty}"\n  A detail view can only draw a tweet the feed has loaded.`
      : `Tweet detail did not open and said nothing about why.`);
  }
}

/* ---------- settling ---------- */

/* Shooting a frame mid-layout is its own way of inventing a bug. Fonts have to be in — a
 * fallback face wraps differently, which is exactly the kind of thing being measured — and
 * images have to have their intrinsic size, since a tweet image with no dimensions yet leaves
 * a hole where the layout question is. */
async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.evaluate(async () => {
    await document.fonts.ready;
    const pending = Array.from(document.images).filter((img) => !img.complete);
    await Promise.all(pending.map((img) => new Promise((done) => {
      // video.twimg.com and some publisher image hosts hotlink-protect, and a blocked image
      // never completes. Waiting it out forever would hang the run, so each one gets a cap.
      const stop = () => done();
      img.addEventListener("load", stop, { once: true });
      img.addEventListener("error", stop, { once: true });
      setTimeout(stop, 3000);
    })));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/* ---------- breakage ---------- */

/* Silent failure is this repo's house specialty, and a screenshot is a very good place for one
 * to hide. An uncaught exception is fatal: the app is plain ES modules with no error boundary,
 * so a thrown error means a view stopped halfway and whatever is on screen is debris. A failed
 * request for the app's own files or its data is fatal too. Third-party media is only a
 * warning — twimg and several publishers refuse hotlinked images by design, and that is what
 * the phone sees as well. */
function watchForBreakage(page) {
  const fatal = [];
  const warn = [];

  page.on("pageerror", (err) => fatal.push(`uncaught ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !isEngineNoise(msg.text())) warn.push(`console: ${msg.text()}`);
  });
  page.on("requestfailed", (req) => {
    const url = req.url();
    const why = `${req.failure()?.errorText || "failed"} ${url}`;
    (isAppAsset(url) ? fatal : warn).push(why);
  });
  page.on("response", (res) => {
    if (res.status() < 400) return;
    const line = `HTTP ${res.status()} ${res.url()}`;
    (isAppAsset(res.url()) ? fatal : warn).push(line);
  });

  const check = () => {
    if (fatal.length) {
      throw new Error(`The page broke while loading:\n  ${fatal.slice(0, 6).join("\n  ")}`);
    }
  };

  return {
    check,
    describeFailures: () => (fatal.concat(warn).slice(0, 4).join("; ") || "No request failed, so look at the console."),
    reportWarnings: () => {
      check();
      if (!warn.length) return;
      console.log("");
      console.log(`${warn.length} non-fatal request/console problem(s) — normal for hotlink-protected media:`);
      for (const line of dedupe(warn).slice(0, 8)) console.log(`  ${line}`);
    },
  };
}

/* WebKit logs an error for every media-control button icon it cannot find in a headless build.
 * There are dozens per tweet video, they say nothing about the app, and left in they bury the
 * one line that would have mattered. */
function isEngineNoise(text) {
  return /Button failed to load, iconName/.test(text);
}

/* The app's own code and data, as opposed to tweet media and publisher thumbnails. */
function isAppAsset(url) {
  if (/\/data\/[a-z]+\.json/.test(url)) return true;
  if (/workers\.dev\/(tweets|usage)/.test(url)) return true;
  if (/\.(js|css|webmanifest)(\?|$)/.test(url) && !/^https?:\/\/(pbs|video|abs)\./.test(url)) return true;
  return false;
}

/* ---------- local server ---------- */

/* `file://` cannot run this app: ES modules are fetched under CORS rules that treat every file
 * URL as a unique opaque origin, and the data/*.json fetches fail the same way. So local mode
 * needs a real HTTP origin, and starting one here beats asking for a second terminal. */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const rel = decodeURIComponent(new URL(req.url, LOCAL_URL).pathname);
      const target = path.join(WEB, rel.endsWith("/") ? `${rel}index.html` : rel);
      // Nothing outside web/ is servable, however the path is spelled.
      if (!path.resolve(target).startsWith(WEB + path.sep)) {
        res.writeHead(403).end("outside web/");
        return;
      }
      const body = await readFile(target);
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });

  await new Promise((resolve, reject) => {
    server.on("error", (err) => {
      reject(err.code === "EADDRINUSE"
        ? new Error(`Port ${LOCAL_PORT} is already in use. Something else is serving — stop it ` +
            `and rerun, or drop --local to shoot the live site. The port is not negotiable: the ` +
            `Worker's CORS allowlist only accepts http://localhost:${LOCAL_PORT}.`)
        : err);
    });
    // localhost, not 127.0.0.1: the Origin header has to match the Worker's allowlist exactly.
    server.listen(LOCAL_PORT, "localhost", resolve);
  });
  return server;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

/* ---------- argv ---------- */

function parseArgs(argv) {
  const opts = { screens: [], scope: null, full: false, local: false, url: null, tweet: 1,
                 out: path.join(ROOT, "screenshots") };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value.`);
      return v;
    };
    switch (arg) {
      case "--local":  opts.local = true; break;
      case "--full":   opts.full = true; break;
      case "--url":    opts.url = next(); break;
      case "--scope":  opts.scope = next(); break;
      case "--tweet":  opts.tweet = next(); break;
      case "--out":    opts.out = path.resolve(next()); break;
      case "-h":
      case "--help":   usage(); process.exit(0);
      default:
        if (arg.startsWith("-")) throw new Error(`Unknown flag ${arg}. Try --help.`);
        if (arg === "all") { opts.screens.push(...ALL); break; }
        if (!SCREENS[arg]) {
          throw new Error(`Unknown screen "${arg}". Pick from: ${Object.keys(SCREENS).join(", ")}, all.`);
        }
        opts.screens.push(arg);
    }
  }

  if (!opts.screens.length) opts.screens = ["tweets"];
  // Asking for --tweet is asking for the detail view, whether or not the screen was named.
  if (opts.tweet !== 1 && !opts.screens.includes("tweet")) opts.screens.push("tweet");
  opts.screens = dedupe(opts.screens);
  return opts;
}

function usage() {
  console.log(`
Screenshot the app in WebKit at iPhone 15 Pro size.

  node scripts/shots.mjs [screens...] [options]

Screens   ${Object.keys(SCREENS).join("  ")}  all
          Default: tweets.

Options
  --local         Serve web/ on localhost:${LOCAL_PORT} and shoot that, for unpushed changes.
                  Without it, the live site is used: ${LIVE_URL}
  --url <url>     Shoot some other origin instead.
  --scope <code>  BAL, national or rivals. Default: the app's own default.
  --tweet <n|id>  Which tweet the detail view opens: a feed row number, or a tweet id.
  --full          Capture the whole scrollable page, not just the viewport.
  --out <dir>     Where the PNGs go. Default: screenshots/

PNGs land in screenshots/, which is gitignored. Exits nonzero, loudly, if a screen did not
render with real data — so a file on disk is a file worth looking at.
`.trim());
}

/* ---------- small helpers ---------- */

function dedupe(list) {
  return Array.from(new Set(list));
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function fail(message) {
  console.error(`\nshots.mjs failed: ${message}`);
  process.exit(1);
}
