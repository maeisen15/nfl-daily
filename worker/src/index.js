/* NFL Daily tweet store.
 *
 * This Worker both fetches tweets and serves them.
 *
 *   scheduled()  -> polls twitterapi.io Advanced Search on a waking-hours cadence and writes
 *                   what it finds, then resolves any new outbound links to preview cards.
 *                   This is the ingest path.
 *   POST /push   -> the pipeline pushes handle->scope routing here (and may push tweets).
 *   POST /ingest -> dormant. The twitterapi.io webhook used to deliver here; its filter rules
 *                   are deactivated. See the cost note on the poll section below before
 *                   turning them back on.
 *   GET  /tweets -> what the PWA reads.
 *
 * Everything lands in the same D1 table keyed by tweet id, so the paths can overlap freely;
 * `richness` decides upsert conflicts and the fuller record always wins.
 *
 * Handle -> scope routing lives in D1, synced from sources.yaml by the pipeline, so adding a
 * handle never requires redeploying this Worker.
 */

const RETENTION_DAYS = 7;
const MAX_LIMIT = 1000;
const DEFAULT_HOURS = 24 * RETENTION_DAYS;
const DEFAULT_PAGE = 200;

// Link previews. Bounded per poll so an ingest burst can't become a fetch storm, and a short
// timeout so a slow publisher never holds up the poll that found the link. A link that failed
// is retried once a week rather than on every poll forever.
const LINK_CARDS_PER_POLL = 12;
const LINK_FETCH_TIMEOUT_MS = 4000;
const LINK_CARD_RETRY_DAYS = 7;
const LINK_CARD_KEEP_DAYS = 30;

// Cron strings, mirrored from wrangler.toml. scheduled() routes on these.
const CRON_POLL  = "*/5 * * * *";
const CRON_PRUNE = "41 8 * * *";

const TWITTERAPI_BASE = "https://api.twitterapi.io";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") return preflight(env, origin);

    try {
      switch (`${request.method} ${url.pathname}`) {
        case "POST /ingest": return await ingest(request, env);
        case "POST /push":   return await push(request, env);
        case "GET /tweets":  return await getTweets(request, env, url, origin);
        case "GET /health":  return await health(env, origin);
        default:
          return json({ error: "not found" }, 404, env, origin);
      }
    } catch (err) {
      // Never leak internals to a caller; the message still reaches `wrangler tail`.
      console.error("unhandled", err && err.stack ? err.stack : String(err));
      return json({ error: "internal error" }, 500, env, origin);
    }
  },

  async scheduled(event, env) {
    if (event.cron === CRON_PRUNE) return await prune(env);
    // Default to the poll: an unrecognised cron is likelier a wrangler.toml edit than a prune,
    // and skipping ingest is a worse failure than pruning twice.
    // The tick's own scheduled time, not now: Cloudflare can deliver a cron a minute late,
    // and reading the clock instead would silently drop that run's ingest.
    return await poll(env, new Date(event.scheduledTime || Date.now()));
  },
};

/* ---------- prune ---------- */

// On a schedule rather than on every write, so an ingest burst stays cheap.
async function prune(env) {
  const cutoff = isoDaysAgo(RETENTION_DAYS);
  const res = await env.DB.prepare("DELETE FROM tweets WHERE published_at < ?").bind(cutoff).run();
  console.log(`pruned ${res.meta?.changes ?? 0} tweets older than ${cutoff}`);

  // Link cards outlive the tweets that referenced them. Nothing older than this window can
  // still be on screen, and a URL that comes back is simply fetched again.
  const cards = await env.DB.prepare("DELETE FROM link_cards WHERE fetched_at < ?")
    .bind(isoDaysAgo(LINK_CARD_KEEP_DAYS)).run();
  console.log(`pruned ${cards.meta?.changes ?? 0} link cards`);
}

/* ---------- write paths ---------- */

// twitterapi.io authenticates its webhook by sending our own API key back to us in X-API-Key.
async function ingest(request, env) {
  if (!timingSafeEqual(request.headers.get("X-API-Key") || "", env.TWITTERAPI_IO_KEY || "")) {
    return json({ error: "unauthorized" }, 401, env, "");
  }
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "bad json" }, 400, env, "");

  const raw = Array.isArray(body.tweets) ? body.tweets : (body.tweet ? [body.tweet] : []);
  const { written } = await upsertAll(env, raw, "webhook");
  // Always 200 on a parseable payload — a non-2xx may make the sender retry or disable the rule,
  // and a tweet we chose to skip (unknown handle) is not a delivery failure.
  return json({ ok: true, received: raw.length, written }, 200, env, "");
}

// The pipeline's sweeps. Bearer secret, separate from the twitterapi.io key.
async function push(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!timingSafeEqual(token, env.PUSH_SECRET || "")) {
    return json({ error: "unauthorized" }, 401, env, "");
  }
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "bad json" }, 400, env, "");

  let handlesSynced = 0;
  if (Array.isArray(body.handles)) handlesSynced = await syncHandles(env, body.handles);

  const raw = Array.isArray(body.tweets) ? body.tweets : [];
  // The only writer that still pushes tweets here is the manual backfill in tweets.py; routine
  // ingest is the Worker's own poll. A sync-handles call carries no tweets at all.
  const source = "search";
  const { written, links } = await upsertAll(env, raw, source);
  if (links.length) await refreshLinkCards(env, links);
  return json({ ok: true, received: raw.length, written, handles_synced: handlesSynced }, 200, env, "");
}

async function syncHandles(env, handles) {
  const now = new Date().toISOString();
  const stmts = [];
  for (const h of handles) {
    const handle = String(h.handle || "").toLowerCase();
    if (!handle) continue;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO handles (handle, display_name, scope, feed_only, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET
           display_name = excluded.display_name,
           scope        = excluded.scope,
           feed_only    = excluded.feed_only,
           updated_at   = excluded.updated_at`
      ).bind(handle, h.display_name || h.handle || "", h.scope || "national", h.feed_only ? 1 : 0, now)
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return stmts.length;
}

/* Returns { written, links } — the link set feeds the preview-card fetcher, which runs after
 * the write rather than inside it so a slow publisher can never stall an ingest. */
async function upsertAll(env, rawTweets, source) {
  if (!rawTweets.length) return { written: 0, links: [] };

  // Only store handles we actually track — a rule edit upstream must not silently widen the app.
  const known = await env.DB.prepare("SELECT handle FROM handles").all();
  const knownSet = new Set((known.results || []).map(r => r.handle));

  const now = new Date().toISOString();
  const cutoff = isoDaysAgo(RETENTION_DAYS);
  const stmts = [];
  const links = new Set();
  for (const raw of rawTweets) {
    const t = normalize(raw, source);
    if (!t) continue;
    if (knownSet.size && !knownSet.has(t.author_handle.toLowerCase())) continue;
    if (t.published_at < cutoff) continue;
    // A reply to someone else is half a conversation the reader can't see, and beat writers
    // generate a lot of it. Replies to self are thread continuations and do belong.
    if (t.is_reply && !t.is_self_thread) continue;
    // A quoted or retweeted post's own links get preview cards too — often the retweet IS the
    // article link, and the wrapper carries none of its own.
    for (const u of [].concat(t.links, (t.quoted && t.quoted.links) || [],
                              (t.retweeted && t.retweeted.links) || [])) links.add(u);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO tweets (id, author_handle, author_name, author_avatar, text, url,
                             published_at, is_retweet, is_reply, is_self_thread, rt_author,
                             retweeted, conversation_id, reply_to_id, like_count, retweet_count,
                             reply_count, view_count, links, media, quoted,
                             richness, source, ingested_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           author_name     = excluded.author_name,
           author_avatar   = excluded.author_avatar,
           text            = excluded.text,
           url             = excluded.url,
           published_at    = excluded.published_at,
           is_retweet      = excluded.is_retweet,
           is_reply        = excluded.is_reply,
           is_self_thread  = excluded.is_self_thread,
           rt_author       = excluded.rt_author,
           retweeted       = excluded.retweeted,
           conversation_id = excluded.conversation_id,
           reply_to_id     = excluded.reply_to_id,
           like_count      = excluded.like_count,
           retweet_count   = excluded.retweet_count,
           reply_count     = excluded.reply_count,
           view_count      = excluded.view_count,
           links           = excluded.links,
           media           = excluded.media,
           quoted          = excluded.quoted,
           richness        = excluded.richness,
           source          = excluded.source
         WHERE excluded.richness >= tweets.richness`
      ).bind(t.id, t.author_handle, t.author_name, t.author_avatar, t.text, t.url,
             t.published_at, t.is_retweet, t.is_reply, t.is_self_thread, t.rt_author,
             t.retweeted ? JSON.stringify(t.retweeted) : null,
             t.conversation_id, t.reply_to_id,
             t.like_count, t.retweet_count, t.reply_count, t.view_count,
             JSON.stringify(t.links), JSON.stringify(t.media),
             t.quoted ? JSON.stringify(t.quoted) : null,
             t.richness, source, now)
    );
  }
  if (!stmts.length) return { written: 0, links: [...links] };
  await env.DB.batch(stmts);
  return { written: stmts.length, links: [...links] };
}

/* ---------- poll: the ingest path ---------- */

/* Cost model, measured directly against the billing endpoint rather than taken from the docs
 * (100,000 credits = $1.00):
 *
 *   a search returning 0 tweets   ~26 credits   flat, per request
 *   a search returning 20 tweets   300 credits   i.e. 15 credits per tweet returned
 *
 * Two things follow, and they drive every decision in this section.
 *
 * First, tweets are billed once each on delivery, so `since_time` is not an optimisation —
 * it is the whole cost control. A poll without it re-returns the same 20 tweets every time
 * and bills 15 credits for each of them, every five minutes. Never widen the watermark
 * casually.
 *
 * Second, the per-request floor is what multiplies, not the handle count: one request covers
 * every handle for the same ~26 credits. So the cheapest arrangement is one query at the
 * fastest cadence any handle needs — splitting the feed into fast and slow tiers would mean
 * asking more often in total and paying the floor more times, for slower tweets. Don't tier.
 *
 * For reference, the filter-rule webhook this replaced billed 15 credits per rule per check
 * whether or not anything matched: 43,200 credits/day, ~$12.87/month of empty polling. The
 * rules in pipeline/rules.py are deactivated. Reactivating them re-arms that meter.
 */

// The API silently returns zero tweets — no error, no message — once a query passes roughly
// 512 characters. That failure is indistinguishable from a quiet news day, so the builder
// splits well short of the cliff and never emits a query that could trip it.
const POLL_QUERY_CHARS = 500;
// Bounds a backfill after a long gap; 12 pages x 20 tweets = 240. Each page costs, so this is
// a spend ceiling as much as a loop guard.
const POLL_MAX_PAGES = 12;
// Re-ask for a sliver we already hold. The search index can surface posts out of order, and a
// handful of duplicate tweets is far cheaper than a hole in the feed.
const POLL_OVERLAP_SEC = 120;
// Floor on the watermark, so a long outage can't trigger an unbounded — and expensive — crawl.
const POLL_MAX_LOOKBACK_H = 26;
// Advanced Search returns 20 per page, and keeps reporting has_next_page even when the page it
// just handed back was partial — so trusting that flag alone costs one empty request, billed at
// the ~26-credit floor, on almost every poll. Measured: it roughly doubled the running cost.
// A short page means the end of the results.
const SEARCH_PAGE_SIZE = 20;

/* Waking-hours cadence, in Eastern. Cloudflare crons are UTC-only and cannot express this, so
 * the cron fires every 5 minutes year-round and the gate lives here instead — which also means
 * the schedule stays correct across DST with no wrangler.toml edit. A gated-out invocation
 * makes no API call and costs nothing.
 *
 * Overnight is dark on purpose: nothing is lost, because the 8am poll's watermark reaches back
 * to the last tweet stored and pulls the whole night in one request. */
function pollCadenceMinutes(hourET) {
  if (hourET >= 9 && hourET < 19) return 5;                      // 9am–7pm, the hours that matter
  if (hourET === 8 || (hourET >= 19 && hourET < 23)) return 15;  // 8–9am and 7–11pm, shoulders
  return 0;                                                       // 11pm–8am, dark
}

function easternParts(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit",
    }).formatToParts(date).map(p => [p.type, p.value])
  );
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

async function poll(env, now) {
  const { hour, minute } = easternParts(now);
  const cadence = pollCadenceMinutes(hour);
  if (cadence === 0) return;
  // The cron ticks every 5 minutes; a 15-minute cadence uses every third tick.
  if (minute % cadence !== 0) return;

  if (!env.TWITTERAPI_IO_KEY) {
    return await recordPoll(env, now, { ok: false, error: "TWITTERAPI_IO_KEY not set" });
  }

  const rows = await env.DB.prepare("SELECT handle FROM handles ORDER BY handle").all();
  const handles = (rows.results || []).map(r => r.handle).filter(Boolean);
  if (!handles.length) {
    // The handles table is synced by the pipeline; empty means that sync never ran, and
    // polling with no handles would just burn the per-request floor for nothing.
    return await recordPoll(env, now, { ok: false, error: "no handles in D1 — run tweets.py --mode sync-handles" });
  }

  const since = await pollWatermark(env, now);
  const queries = buildPollQueries(handles, since);

  let returned = 0, pages = 0, written = 0, truncated = false;
  const links = new Set();
  try {
    for (const query of queries) {
      let cursor = "", page = 0;
      while (page < POLL_MAX_PAGES) {
        const body = await searchPage(env, query, cursor);
        const tweets = Array.isArray(body.tweets) ? body.tweets : [];
        returned += tweets.length;
        page += 1; pages += 1;
        if (tweets.length) {
          const res = await upsertAll(env, tweets, "poll");
          written += res.written;
          for (const u of res.links) links.add(u);
        }
        cursor = body.next_cursor || "";
        if (!body.has_next_page || !cursor || !tweets.length) break;
        // The load-bearing one: stop on a partial page rather than paying for the empty page
        // that has_next_page would otherwise send us to fetch.
        if (tweets.length < SEARCH_PAGE_SIZE) break;
      }
      if (page >= POLL_MAX_PAGES) truncated = true;
    }
  } catch (err) {
    console.error("poll failed", err && err.stack ? err.stack : String(err));
    return await recordPoll(env, now, {
      ok: false, error: String(err && err.message ? err.message : err),
      since: since.toISOString(), queries: queries.length, returned, written,
    });
  }

  // After the write, never during it: a preview fetch that hangs must not cost us the tweets.
  let cards = 0;
  try {
    cards = await refreshLinkCards(env, [...links]);
  } catch (err) {
    console.error("link cards failed", err && err.stack ? err.stack : String(err));
  }

  if (truncated) console.warn(`poll hit the ${POLL_MAX_PAGES}-page cap; window not fully covered`);
  console.log(`poll: ${handles.length} handles, ${queries.length} query(s), ${pages} page(s), ` +
              `${returned} returned, ${written} written, since ${since.toISOString()}`);

  await recordPoll(env, now, {
    ok: true, cadence_minutes: cadence, since: since.toISOString(),
    handles: handles.length, queries: queries.length, pages,
    returned, written, truncated, link_cards: cards,
    // ~26 credits per request plus 15 per tweet returned; useful for spotting a cost regression.
    est_credits: pages * 26 + returned * 15,
  });
}

/* Where to resume from: the newest tweet already stored, less a small overlap. Keeping the
 * watermark in the store rather than in a counter means a missed run self-heals — the next
 * poll simply asks for a wider window — and a restored Worker resumes exactly where it left
 * off. Floored so it can never become an unbounded crawl. */
async function pollWatermark(env, now) {
  const floor = new Date(now.getTime() - POLL_MAX_LOOKBACK_H * 3600_000);
  const row = await env.DB.prepare("SELECT MAX(published_at) AS newest FROM tweets").first();
  if (!row || !row.newest) return floor;
  const newest = new Date(row.newest);
  if (isNaN(newest)) return floor;
  const since = new Date(newest.getTime() - POLL_OVERLAP_SEC * 1000);
  return since < floor ? floor : since;
}

/* Pack handles into as few queries as the length budget allows. Grouping is purely by length,
 * never by scope: the Worker routes on the author's handle, so a query may freely span tabs,
 * and fewer queries means the per-request floor is paid fewer times. */
function buildPollQueries(handles, since) {
  const suffix = ` include:nativeretweets since_time:${Math.floor(since.getTime() / 1000)}`;
  const budget = POLL_QUERY_CHARS - suffix.length - 2;  // the wrapping parens
  const queries = [];
  let group = [], length = 0;
  for (const handle of handles) {
    const term = `from:${handle}`;
    // A single handle wider than the whole budget can't be expressed; dropping it is bad, but
    // emitting an over-length query that silently returns nothing for *every* handle is worse.
    if (term.length > budget) {
      console.warn(`poll: handle ${handle} too long for a query budget of ${budget}; skipped`);
      continue;
    }
    const addition = group.length ? term.length + 4 : term.length;  // " OR "
    if (group.length && length + addition > budget) {
      queries.push(`(${group.join(" OR ")})${suffix}`);
      group = []; length = 0;
    }
    group.push(term);
    length += group.length === 1 ? term.length : term.length + 4;
  }
  if (group.length) queries.push(`(${group.join(" OR ")})${suffix}`);
  return queries;
}

async function searchPage(env, query, cursor) {
  const url = new URL(`${TWITTERAPI_BASE}/twitter/tweet/advanced_search`);
  url.searchParams.set("query", query);
  url.searchParams.set("queryType", "Latest");
  if (cursor) url.searchParams.set("cursor", cursor);
  const res = await fetch(url.toString(), { headers: { "X-API-Key": env.TWITTERAPI_IO_KEY } });
  if (!res.ok) throw new Error(`advanced_search returned ${res.status}`);
  return await res.json();
}

// A poll that finds nothing and a poll that quietly broke look identical from the outside, so
// every run leaves a record and /health reports the last one.
async function recordPoll(env, now, detail) {
  if (!detail.ok) console.error("poll not ok:", JSON.stringify(detail));
  const value = JSON.stringify({ at: now.toISOString(), ...detail });
  await env.DB.prepare(
    `INSERT INTO meta (key, value, updated_at) VALUES ('last_poll', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(value, now.toISOString()).run();
}

/* ---------- link preview cards ---------- */

/* A tweet linking to an article shows the article's own headline and image, the way Twitter
 * does — for this reader that card is a primary way articles get found, so it is worth a
 * fetch. Cloudflare's outbound requests are free, and each URL is fetched exactly once and
 * then served from D1 forever after. */
async function refreshLinkCards(env, urls) {
  if (!urls.length) return 0;

  // Anything already resolved is done. A previous failure is retried, but only weekly — a
  // paywall or a dead host would otherwise be re-fetched on every poll for as long as the
  // tweet stands.
  const retryBefore = isoDaysAgo(LINK_CARD_RETRY_DAYS);
  const done = new Set();
  // D1 caps bound parameters per statement. A poll after the overnight gap carries a whole
  // night of links, so this has to chunk rather than bind them all at once.
  const CHUNK = 90;
  for (let i = 0; i < urls.length; i += CHUNK) {
    const slice = urls.slice(i, i + CHUNK);
    const known = await env.DB.prepare(
      `SELECT url, status, fetched_at FROM link_cards
        WHERE url IN (${slice.map(() => "?").join(",")})`
    ).bind(...slice).all();
    for (const r of known.results || []) {
      if (r.status === "ok" || r.fetched_at > retryBefore) done.add(r.url);
    }
  }

  const todo = urls.filter(u => !done.has(u)).slice(0, LINK_CARDS_PER_POLL);
  if (!todo.length) return 0;

  const cards = await Promise.all(todo.map(fetchOpenGraph));
  const now = new Date().toISOString();
  await env.DB.batch(cards.map(c => env.DB.prepare(
    `INSERT INTO link_cards (url, title, description, image, domain, status, fetched_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(url) DO UPDATE SET
       title = excluded.title, description = excluded.description, image = excluded.image,
       domain = excluded.domain, status = excluded.status, fetched_at = excluded.fetched_at`
  ).bind(c.url, c.title, c.description, c.image, c.domain, c.status, now)));

  return cards.length;
}

/* Reads the destination's Open Graph tags with HTMLRewriter, which streams the response rather
 * than buffering a whole article page into memory. A failure is recorded, not thrown: a link
 * we can't read renders as a plain link rather than blocking anything. */
async function fetchOpenGraph(url) {
  const card = { url, title: null, description: null, image: null, domain: safeHost(url), status: "error" };
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(LINK_FETCH_TIMEOUT_MS),
      headers: {
        // Publishers serve Open Graph tags to crawlers they recognise; an unidentified client
        // gets a bot wall from some of them.
        "User-Agent": "Mozilla/5.0 (compatible; NFLDailyBot/1.0; +https://maeisen15.github.io/nfl-daily/)",
        "Accept": "text/html,application/xhtml+xml",
      },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!res.ok || !/text\/html/i.test(res.headers.get("content-type") || "")) return card;

    const found = {};
    let titleText = "";
    const meta = (el) => {
      const key = String(el.getAttribute("property") || el.getAttribute("name") || "").toLowerCase();
      const content = el.getAttribute("content");
      if (!content) return;
      if (key === "og:title" || key === "twitter:title") found.title ??= content;
      else if (key === "og:description" || key === "twitter:description") found.description ??= content;
      else if (key === "og:image" || key === "og:image:secure_url" || key === "twitter:image")
        found.image ??= content;
      else if (key === "og:site_name") found.site ??= content;
    };

    await new HTMLRewriter()
      .on("meta", { element: meta })
      .on("title", { text(t) { if (titleText.length < 300) titleText += t.text; } })
      .transform(res)
      .arrayBuffer();   // drain the stream so the handlers actually run

    const finalUrl = res.url || url;
    card.title = clean(found.title || titleText, 200);
    card.description = clean(found.description, 300);
    card.image = absoluteUrl(found.image, finalUrl);
    card.domain = found.site ? clean(found.site, 60) : safeHost(finalUrl) || card.domain;
    card.status = (card.title || card.image) ? "ok" : "empty";
    return card;
  } catch {
    return card;
  }
}

function clean(text, max) {
  if (!text) return null;
  const s = decodeEntities(String(text)).replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "\u2026" : s;
}

/* Publishers serve og:image as an absolute URL, a protocol-relative one, or a site-root path —
 * and very often with its query string HTML-escaped, because the tag was written by a template
 * engine that escapes every attribute. A `&amp;` left in the URL breaks image CDNs that parse
 * their own query string (the Banner's resizer answers 400), so decode before resolving. */
function absoluteUrl(value, base) {
  if (!value) return null;
  try {
    const resolved = new URL(decodeEntities(String(value)).trim(), base);
    return resolved.protocol === "https:" || resolved.protocol === "http:" ? resolved.toString() : null;
  } catch { return null; }
}

/* ---------- read path ---------- */

async function getTweets(request, env, url, origin) {
  const scope = url.searchParams.get("scope") || "";
  const hours = clampInt(url.searchParams.get("hours"), DEFAULT_HOURS, 1, 24 * RETENTION_DAYS);
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_PAGE, 1, MAX_LIMIT);
  const cursor = parseCursor(url.searchParams.get("cursor"));
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  // Scope lives on the handles table, so a routing change takes effect without a rewrite here.
  let sql =
    `SELECT t.id, t.author_handle, t.author_name, t.author_avatar, t.text, t.url,
            t.published_at, t.is_retweet, t.is_reply, t.is_self_thread, t.rt_author,
            t.retweeted, t.conversation_id, t.reply_to_id, t.like_count, t.retweet_count,
            t.reply_count, t.view_count, t.links, t.media, t.quoted,
            h.scope, h.display_name
       FROM tweets t JOIN handles h ON h.handle = LOWER(t.author_handle)
      WHERE t.published_at >= ?`;
  const binds = [since];
  if (scope) { sql += " AND h.scope = ?"; binds.push(scope); }
  // Keyset pagination on the same key the index is sorted by, so page N costs the same as page
  // one — OFFSET would make deep scrollback progressively slower.
  if (cursor) {
    sql += " AND (t.published_at < ? OR (t.published_at = ? AND t.id < ?))";
    binds.push(cursor.at, cursor.at, cursor.id);
  }
  sql += " ORDER BY t.published_at DESC, t.id DESC LIMIT ?";
  binds.push(limit + 1);   // one extra row answers "is there another page?" without a count

  const rows = await env.DB.prepare(sql).bind(...binds).all();
  const results = rows.results || [];
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;

  const items = page.map(r => ({
    id: r.id,
    type: "tweet",
    scopes: [r.scope],
    source_id: `twitter_${r.author_handle}`,
    source_name: r.display_name || r.author_name || r.author_handle,
    author_handle: r.author_handle,
    author_name: r.display_name || r.author_name || r.author_handle,
    author_avatar: r.author_avatar || null,
    text: r.text,
    url: r.url,
    published_at: r.published_at,
    is_retweet: !!r.is_retweet,
    is_self_thread: !!r.is_self_thread,
    rt_author: r.rt_author || null,
    retweeted: safeParse(r.retweeted, null),
    conversation_id: r.conversation_id || null,
    reply_to_id: r.reply_to_id || null,
    like_count: r.like_count,
    retweet_count: r.retweet_count,
    reply_count: r.reply_count,
    view_count: r.view_count,
    links: safeParse(r.links, []),
    media: safeParse(r.media, []),
    quoted: safeParse(r.quoted, null),
  }));

  await attachLinkCards(env, items);

  const last = page.length ? page[page.length - 1] : null;
  const newest = items.length ? items[0].published_at : null;
  return json(
    { schema_version: 2, generated_at: new Date().toISOString(), newest_tweet_at: newest,
      scope: scope || "all", window_hours: hours, count: items.length, items,
      next_cursor: hasMore && last ? makeCursor(last.published_at, last.id) : null },
    200, env, origin,
    // Short edge cache: keeps a burst of app opens off D1 without making tweets feel stale.
    { "Cache-Control": "public, max-age=30" }
  );
}

/* Resolves each item's first link to its cached preview card. One query for the whole page
 * rather than one per tweet. A link with no card yet renders as a plain link until the next
 * poll fetches it. */
async function attachLinkCards(env, items) {
  const wanted = new Map();   // url -> the items waiting on it
  const want = (url, target) => {
    if (!url) return;
    if (!wanted.has(url)) wanted.set(url, []);
    wanted.get(url).push(target);
  };
  for (const it of items) {
    want(it.links[0], it);
    if (it.quoted && it.quoted.links) want(it.quoted.links[0], it.quoted);
    if (it.retweeted && it.retweeted.links) want(it.retweeted.links[0], it.retweeted);
  }
  if (!wanted.size) return;

  const urls = [...wanted.keys()];
  // D1 caps bound parameters per statement; chunk rather than risk a silent truncation.
  const CHUNK = 90;
  for (let i = 0; i < urls.length; i += CHUNK) {
    const slice = urls.slice(i, i + CHUNK);
    const rows = await env.DB.prepare(
      `SELECT url, title, description, image, domain FROM link_cards
        WHERE status = 'ok' AND url IN (${slice.map(() => "?").join(",")})`
    ).bind(...slice).all();
    for (const r of rows.results || []) {
      for (const target of wanted.get(r.url) || []) {
        target.link_card = { url: r.url, title: r.title, description: r.description,
                             image: r.image, domain: r.domain };
      }
    }
  }
}

/* The cursor is the sort key itself, not an opaque token, so it stays valid across deploys and
 * a client can be handed one without the server holding any state. */
function makeCursor(publishedAt, id) {
  return btoa(`${publishedAt}|${id}`).replace(/=+$/, "");
}

function parseCursor(value) {
  if (!value) return null;
  try {
    const [at, id] = atob(value).split("|");
    return at && id ? { at, id } : null;
  } catch { return null; }
}

async function health(env, origin) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n, MAX(published_at) AS newest, MAX(ingested_at) AS last_ingest
       FROM tweets`
  ).first();
  const bySource = await env.DB.prepare(
    "SELECT source, COUNT(*) AS n FROM tweets GROUP BY source"
  ).all();
  const handles = await env.DB.prepare("SELECT COUNT(*) AS n FROM handles").first();
  const lastPoll = await env.DB.prepare("SELECT value FROM meta WHERE key = 'last_poll'").first();
  const cards = await env.DB.prepare(
    "SELECT COUNT(*) AS n, SUM(status = 'ok') AS ok FROM link_cards"
  ).first();
  const rich = await env.DB.prepare(
    "SELECT SUM(author_avatar IS NOT NULL) AS n FROM tweets"
  ).first();
  return json({
    ok: true,
    tweets: row?.n ?? 0,
    // How far the store has healed since the rich-tweet fields shipped: rows written before
    // then have no avatar and render without one until they age out.
    tweets_with_avatar: rich?.n ?? 0,
    link_cards: { total: cards?.n ?? 0, ok: cards?.ok ?? 0 },
    handles: handles?.n ?? 0,
    newest_tweet_at: row?.newest ?? null,
    last_ingest_at: row?.last_ingest ?? null,
    by_source: Object.fromEntries((bySource.results || []).map(r => [r.source, r.n])),
    retention_days: RETENTION_DAYS,
    // The ingest path's own report card — see recordPoll().
    last_poll: safeParse(lastPoll?.value, null),
  }, 200, env, origin);
}

/* ---------- normalization ---------- */

/* Accepts both shapes we might be handed: the full tweet object the REST endpoints return
 * (createdAt / author.userName / extendedEntities) and the flatter one documented for the
 * webhook (created_at / author.username). Anything missing a usable id, author, or timestamp
 * is dropped rather than stored half-formed. */
function normalize(raw, source) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || raw.id_str || "");
  if (!id) return null;

  const author = raw.author || raw.user || {};
  const handle = String(author.userName || author.username || author.screen_name || "");
  if (!handle) return null;

  const published = toIso(raw.createdAt || raw.created_at);
  if (!published) return null;

  const text = decodeEntities(String(raw.text || raw.full_text || "").trim());
  const rt = raw.retweeted_tweet || raw.retweetedTweet || null;
  const isRetweet = !!rt || /^RT @/.test(text);
  const isReply = !!(raw.isReply || raw.in_reply_to_id || raw.inReplyToId || raw.in_reply_to_status_id);
  const replyToHandle = String(
    raw.inReplyToUsername || raw.in_reply_to_username || raw.in_reply_to_screen_name || ""
  );

  // A reply to yourself is a thread continuation and belongs in the feed; a reply to someone
  // else is half a conversation and does not.
  const isSelfThread = isReply && !!replyToHandle &&
    replyToHandle.toLowerCase() === handle.toLowerCase();

  const media = extractMedia(raw);
  const avatar = pickAvatar(author);
  const counts = pickCounts(raw);

  // Which fields we actually captured, so the fuller record wins an upsert race. A thin
  // webhook payload has none of them; a full REST object has media entities; only the current
  // normalizer captures avatars and counts, which is what lets a re-fetched tweet upgrade a
  // row written before this shipped.
  const rich = !!avatar || counts.like_count !== null;
  const richness = rich ? 2 : (("extendedEntities" in raw || "extended_entities" in raw) ? 1 : 0);

  return {
    id,
    author_handle: handle,
    author_name: decodeEntities(String(author.name || handle)),
    author_avatar: avatar,
    text,
    url: String(raw.url || `https://twitter.com/${handle}/status/${id}`),
    published_at: published,
    is_retweet: isRetweet ? 1 : 0,
    is_reply: isReply ? 1 : 0,
    is_self_thread: isSelfThread ? 1 : 0,
    rt_author: rt ? String((rt.author || {}).userName || (rt.author || {}).username || "") : null,
    // The post being retweeted, in full. Twitter renders a retweet as the original tweet with
    // a "X reposted" line above it, so the truncated `RT @handle: …` string in `text` is a
    // fallback for thin payloads rather than something to display.
    retweeted: extractTweetRef(rt),
    conversation_id: firstString(raw.conversationId, raw.conversation_id, raw.conversation_id_str) || null,
    reply_to_id: firstString(raw.inReplyToId, raw.in_reply_to_id, raw.in_reply_to_status_id) || null,
    ...counts,
    links: extractLinks(raw),
    media,
    quoted: extractTweetRef(raw.quoted_tweet || raw.quotedTweet),
    richness,
  };
}

/* A tweet referenced by another tweet — quoted or retweeted. Both render as a tweet in their
 * own right (the retweet as the main row, the quote as a nested card), so both carry the same
 * fields, including the counts, which on a retweet belong to the original and not to the
 * near-always-zero wrapper. */
function extractTweetRef(t) {
  if (!t || typeof t !== "object") return null;
  const author = t.author || t.user || {};
  const handle = String(author.userName || author.username || author.screen_name || "");
  const text = decodeEntities(String(t.text || t.full_text || "").trim());
  const media = extractMedia(t);
  if (!text && !media.length) return null;
  const id = String(t.id || t.id_str || "");
  return {
    id: id || null,
    author_handle: handle,
    author_name: decodeEntities(String(author.name || handle)),
    author_avatar: pickAvatar(author),
    text,
    url: String(t.url || (handle && id ? `https://twitter.com/${handle}/status/${id}` : "")),
    published_at: toIso(t.createdAt || t.created_at),
    media,
    links: extractLinks(t),
    ...pickCounts(t),
  };
}

/* Twitter serves avatars at `_normal` (48px), which is a blurry mess on a 3x phone display.
 * The same path at `_400x400` is the retina asset. */
function pickAvatar(author) {
  const raw = String(
    author.profilePicture || author.profile_image_url_https || author.profile_image_url || ""
  );
  if (!/^https?:\/\//i.test(raw)) return null;
  return raw.replace(/_normal\.(jpg|jpeg|png|webp|gif)$/i, "_400x400.$1");
}

/* Engagement counts, captured once at fetch time and never updated afterwards — a frozen
 * snapshot is what the app shows, and refreshing them would mean re-fetching tweets we have
 * already paid for. */
function pickCounts(raw) {
  const n = (v) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? Math.trunc(x) : null;
  };
  return {
    like_count:    n(raw.likeCount    ?? raw.favorite_count ?? raw.favoriteCount),
    retweet_count: n(raw.retweetCount ?? raw.retweet_count),
    reply_count:   n(raw.replyCount   ?? raw.reply_count),
    view_count:    n(raw.viewCount    ?? raw.view_count ?? raw.views),
  };
}

/* Outbound links, which become preview cards. t.co stubs are useless — `expanded_url` is the
 * real destination — and links back to Twitter itself are the quote-tweet and media stubs we
 * already render as their own cards. */
function extractLinks(raw) {
  const entities = raw.entities || {};
  const urls = [].concat(entities.urls || [], (entities.url && entities.url.urls) || []);
  const out = [];
  for (const u of urls) {
    const expanded = String(u.expanded_url || u.expandedUrl || u.url || "");
    if (!/^https?:\/\//i.test(expanded)) continue;
    const host = safeHost(expanded);
    if (!host || host === "twitter.com" || host === "x.com" || host === "t.co") continue;
    if (!out.includes(expanded)) out.push(expanded);
  }
  return out;
}

function firstString(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function extractMedia(raw) {
  const ee = raw.extendedEntities || raw.extended_entities || {};
  const out = [];
  for (const m of ee.media || []) {
    const type = m.type || "photo";
    const poster = m.media_url_https || m.media_url || "";
    if (type === "video" || type === "animated_gif") {
      const vurl = pickMp4(m);
      if (!vurl) continue;
      out.push({ type, url: poster, video_url: vurl, loop: type === "animated_gif" });
    } else if (poster) {
      out.push({ type, url: poster });
    }
  }
  return out;
}

function pickMp4(media) {
  const vi = media.video_info || media.videoInfo || {};
  const variants = (vi.variants || []).filter(
    v => (v.content_type || v.contentType) === "video/mp4" && v.url
  );
  if (!variants.length) return "";
  const br = v => Number(v.bitrate || 0) || 0;
  // Cap at 720p so a tweet video doesn't burn cellular data; fall back to the best available.
  const capped = variants.filter(v => v.url.includes("/1280x720/") || br(v) <= 2176000);
  return (capped.length ? capped : variants).reduce((a, b) => (br(b) > br(a) ? b : a)).url;
}

/* Twitter serves tweet text with &amp; / &lt; / &gt; already escaped. Decoding here means the
 * app can escape once at render time without producing a literal "&amp;" on screen. */
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const named = NAMED[body.toLowerCase()];
    return named === undefined ? m : named;
  });
}

/* ---------- helpers ---------- */

function toIso(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d) ? null : d.toISOString();
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value || "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeParse(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// Constant-time compare so a wrong secret can't be recovered by timing the response.
function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function corsHeaders(env, origin) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : (allowed[0] || "*"),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
    "Vary": "Origin",
  };
}

function preflight(env, origin) {
  return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
}

function json(payload, status, env, origin, extra) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(env, origin), ...(extra || {}) },
  });
}
