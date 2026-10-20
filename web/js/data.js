/* Everything that talks to the network.
 *
 * Two sources, deliberately separate. `web/data/*.json` is rebuilt hourly by the pipeline and
 * carries articles and the digest. Tweets come live from the Cloudflare Worker, which polls
 * twitterapi.io every five minutes — so the first paint never waits on them.
 */

const OFFLINE_KEY = "nfl-daily.offline.v1";
const OFFLINE_TWEETS = 120;   // enough to fill a few screens without crowding the quota
const PAGE = 200;

export const state = {
  config: null,
  vertical: null,     // the entry from config.verticals the app is currently showing
  feed: null,
  digest: null,
  gameweek: null,
  schedule: null,
  offline: false,
};

export function verticals() {
  return state.config?.verticals || [];
}

export function findVertical(code) {
  return verticals().find(v => v.code === code) || null;
}

/* Every per-vertical file lives under that vertical's own directory. Football's is still the
 * root, because moving it would have meant changing the output path of four pipeline scripts
 * to no visible end; a vertical added later gets a directory of its own. */
function dataPath(name) {
  const dir = (state.vertical?.data_dir || "data").replace(/\/$/, "");
  return `${dir}/${name}`;
}

/* How long a set of hourly files is considered current. Shorter than the hour they are built
 * on, so a resume after any real gap picks the new ones up. */
const STATIC_TTL_MS = 10 * 60_000;
let lastStaticAt = 0;

/* The config describes the whole app and is read once; everything else belongs to one vertical
 * and is re-read whenever the vertical changes. */
export async function loadConfig() {
  state.config = await fetchJson(`data/config.json?v=${Date.now()}`);
  return state.config;
}

async function fetchStatic() {
  const bust = `?v=${Date.now()}`;
  // None of these is fatal. A vertical whose sources haven't been set up yet has no files at
  // all, and that has to read as an empty feed rather than an app that won't open — you still
  // need to be able to switch back out of it. A real outage fails config.json instead, which
  // is fatal, so the "couldn't load" path still means what it says.
  const [feed, digest, gameweek] = await Promise.all([
    fetchJson(`${dataPath("feed.json")}${bust}`).catch(() => null),
    fetchJson(`${dataPath("digest.json")}${bust}`).catch(() => null),
    fetchJson(`${dataPath("gameweek.json")}${bust}`).catch(() => null),
  ]);
  state.feed = feed;
  state.digest = digest;
  state.gameweek = currentDossier(gameweek);
  lastStaticAt = Date.now();
}

/* The dossier describes one upcoming game, so a dossier whose game has already been played is
 * proof that building it failed and the copy committed in the repo was served instead. Showing
 * it is worse than showing nothing — it spent six weeks presenting Week 1's injury report
 * against an opponent the team had long since played — so a stale one is treated as absent. */
function currentDossier(gw) {
  const game = gw && gw.game;
  if (!game) return gw;
  if (game.state === "post" || game.completed) return null;
  const kickoff = Date.parse(game.date);
  // An hour past a listed kickoff with no result yet is just a game in progress. A day is not.
  if (Number.isFinite(kickoff) && Date.now() - kickoff > 24 * 3600_000) return null;
  return gw;
}

export async function loadStatic() {
  await fetchStatic();
  return state;
}

/* Point the app at a vertical and read its files. Everything cached for the old one is dropped
 * rather than left to be filtered out later: the schedule is memoised for the session, and the
 * dossier and digest are keyed by scopes that don't exist in the vertical being switched to. */
export async function selectVertical(code) {
  const next = findVertical(code) || verticals()[0] || null;
  if (!next) throw new Error("config has no verticals");
  if (state.vertical && state.vertical.code === next.code) return next;
  state.vertical = next;
  state.feed = null;
  state.digest = null;
  state.gameweek = null;
  state.schedule = null;
  schedulePromise = null;
  lastStaticAt = 0;
  await fetchStatic();
  return next;
}

/* The hourly rebuild only reaches the app if the app asks for these files again, and until
 * now nothing ever did: they were read once at boot and never re-read. On an installed home
 * screen app that is close to never — iOS suspends the page rather than killing it, so one
 * page can live for weeks. Tweets kept polling and looked live, which is exactly what made
 * the rest look current too: the articles, the brief, the schedule, the scores and the
 * standings were all frozen at whatever they were the first time the app opened.
 *
 * Returns whether anything was actually re-read, so the caller only redraws when it was. A
 * failure is not propagated: the files on screen are still good, and the next poll retries. */
export async function refreshStatic({ force = false } = {}) {
  if (!force && Date.now() - lastStaticAt < STATIC_TTL_MS) return false;
  try {
    await fetchStatic();
    // The schedule is fetched lazily and memoised for the session, so it needs its own nudge.
    // The old copy stays on screen until the new one lands, rather than blanking the tab.
    schedulePromise = null;
    loadSchedule().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/* This week's opponent beat writer, scoped so it never appears in a feed. Fetched when the
 * Brief is opened rather than baked into gameweek.json, which every app launch loads. */
export async function fetchOpponentTweets(handle, limit = 30) {
  const base = (state.config?.tweets_url || "").replace(/\/$/, "");
  if (!base || !handle) return [];
  const url = new URL(`${base}/tweets`);
  // By author, not by scope: a rival who is also this week's opponent stays scoped `rivals`,
  // and asking for the opponent scope would come back empty for those weeks.
  url.searchParams.set("handle", handle);
  url.searchParams.set("hours", "168");
  url.searchParams.set("limit", String(limit));
  const body = await fetchJson(url.toString());
  return Array.isArray(body.items) ? body.items : [];
}

/* The whole season is 125KB, which is not worth adding to every cold start for a tab that
 * may never be opened. Fetched on first visit and held for the session; `refreshStatic`
 * clears the hold so scores and standings follow the hourly rebuild. */
let schedulePromise = null;

export function loadSchedule() {
  if (!schedulePromise) {
    schedulePromise = fetchJson(`${dataPath("schedule.json")}?v=${Date.now()}`)
      .then(data => { state.schedule = data; return data; })
      .catch(err => { schedulePromise = null; throw err; });
  }
  return schedulePromise;
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function workerBase() {
  return (state.config && state.config.tweets_url) || "";
}

/* One page of tweets. `cursor` continues where the last page stopped; the Worker's cursor is
 * a sort key, so paging stays correct even as new tweets arrive at the top. */
export async function fetchTweets({ cursor = null, limit = PAGE, since = null } = {}) {
  const base = workerBase();
  if (!base) throw new Error("no tweets_url in config");
  const url = new URL(`${base}/tweets`);
  url.searchParams.set("hours", "168");
  url.searchParams.set("limit", String(limit));
  if (cursor) url.searchParams.set("cursor", cursor);
  const body = await fetchJson(url.toString(), { cache: since ? "no-store" : "default" });
  return {
    items: Array.isArray(body.items) ? body.items : [],
    cursor: body.next_cursor || null,
    newest: body.newest_tweet_at || null,
  };
}

/* The first page, with a fallback chain: the Worker, then whatever was cached from the last
 * successful load, then the tweets baked into feed.json by the hourly run. The tab should
 * never be blank just because the phone lost signal. */
export async function loadFirstTweets() {
  try {
    const page = await fetchTweets({});
    state.offline = false;
    cacheOffline(page.items);
    return page;
  } catch {
    state.offline = true;
    const cached = readOffline();
    if (cached.length) return { items: cached, cursor: null, newest: cached[0].published_at };
    const baked = (state.feed?.items || []).filter(i => i.type === "tweet");
    return { items: baked, cursor: null, newest: baked.length ? baked[0].published_at : null };
  }
}

function cacheOffline(items) {
  try {
    localStorage.setItem(OFFLINE_KEY, JSON.stringify(items.slice(0, OFFLINE_TWEETS)));
  } catch {
    // Quota, or storage disabled. Offline reading is a nicety; losing it changes nothing else.
  }
}

function readOffline() {
  try {
    const raw = localStorage.getItem(OFFLINE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function articles(scope) {
  return (state.feed?.items || []).filter(i => i.type === "article" && (i.scopes || []).includes(scope));
}

export function digestFor(scope) {
  const tabs = state.digest?.tabs || [];
  const tab = tabs.find(t => t.scope === scope);
  return tab ? tab.markdown : null;
}
