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
  feed: null,
  digest: null,
  gameweek: null,
  schedule: null,
  offline: false,
};

export async function loadStatic() {
  const bust = `?v=${Date.now()}`;
  const [config, feed, digest, gameweek] = await Promise.all([
    fetchJson(`data/config.json${bust}`),
    fetchJson(`data/feed.json${bust}`),
    fetchJson(`data/digest.json${bust}`),
    // Small, and the Brief opens on it — but the app has to work before this file has ever
    // been written, so its absence is a missing section rather than a failed boot.
    fetchJson(`data/gameweek.json${bust}`).catch(() => null),
  ]);
  state.config = config;
  state.feed = feed;
  state.digest = digest;
  state.gameweek = gameweek;
  return state;
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
 * may never be opened. Fetched once on first visit and kept for the session; the hourly
 * rebuild is picked up on the next app launch, which is soon enough for a schedule. */
let schedulePromise = null;

export function loadSchedule() {
  if (!schedulePromise) {
    schedulePromise = fetchJson(`data/schedule.json?v=${Date.now()}`)
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
