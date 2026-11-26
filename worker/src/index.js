/* NFL Daily tweet store.
 *
 * This Worker both fetches tweets and serves them.
 *
 *   scheduled()  -> polls twitterapi.io Advanced Search on a waking-hours cadence and writes
 *                   what it finds. This is the ingest path.
 *   POST /push   -> the pipeline pushes handle->scope routing here (and may push tweets).
 *   POST /ingest -> dormant. The twitterapi.io webhook used to deliver here; its filter rules
 *                   are deactivated. See the cost note on the poll section below before
 *                   turning them back on.
 *   GET  /tweets -> what the PWA reads.
 *
 * Everything lands in the same D1 table keyed by tweet id, so the paths can overlap freely;
 * `richness` decides upsert conflicts and the fuller record always wins.
 *
 * Handle -> vertical/scope routing lives in D1, synced from the pipeline's sources files, so adding a
 * handle never requires redeploying this Worker.
 */

const RETENTION_DAYS = 7;
const MAX_LIMIT = 1000;
const DEFAULT_HOURS = 24 * RETENTION_DAYS;
const DEFAULT_PAGE = 200;

/* twitterapi.io pricing, in credits, where 100,000 credits = $1.00. Measured against the
 * billing endpoint: a request returning nothing costs ~26, and a request returning 20 tweets
 * costs 300 — exactly 20 x 15, with no separate base added on top. So the floor is what an
 * empty request costs, not a surcharge, and two tweets is enough to clear it.
 *
 * There is no billing API and no cost header on a response, so this cannot be checked against
 * an invoice from here. That is why usage_daily stores requests and tweets rather than
 * dollars: if these numbers are wrong, correcting them re-prices the whole history. */
const CREDITS_PER_REQUEST_FLOOR = 26;
const CREDITS_PER_TWEET = 15;
const CREDITS_PER_USD = 100_000;

function requestCredits(tweets) {
  return Math.max(CREDITS_PER_REQUEST_FLOOR, tweets * CREDITS_PER_TWEET);
}

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
        case "GET /usage":   return await usage(env, url, origin);
        case "GET /injuries": return await getInjuries(env, url, origin);
        case "POST /injuries": return await putInjuries(request, env);
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

  const polls = await env.DB.prepare("DELETE FROM poll_log WHERE at < ?")
    .bind(isoDaysAgo(POLL_LOG_KEEP_DAYS)).run();
  console.log(`pruned ${polls.meta?.changes ?? 0} poll log rows`);
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
  const { written } = await upsertAll(env, raw, source);

  // A manual backfill is bought from the same account as the poll, so it belongs in the same
  // ledger. The caller reports its own request count because only it knows how many pages it
  // asked for; without that the month understates what was actually spent.
  if (body.usage && Number(body.usage.requests) > 0) {
    // The caller counts this, because tweets arrive here in batches and only the first carries
    // the usage payload — tallying the batch in hand would undercount every backfill that
    // needed more than one.
    const byHandle = new Map(Object.entries(body.usage.by_handle || {})
      .map(([h, n]) => [String(h).toLowerCase(), Number(n) || 0]));
    try {
      await recordUsage(env, new Date(), {
        polls: 0, requests: Number(body.usage.requests),
        tweets: Number(body.usage.tweets ?? raw.length), byHandle,
      });
    } catch (err) {
      console.error("usage record failed", err && err.stack ? err.stack : String(err));
    }
  }
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
        `INSERT INTO handles (handle, display_name, scope, vertical, feed_only, poll_minutes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(handle) DO UPDATE SET
           display_name = excluded.display_name,
           scope        = excluded.scope,
           vertical     = excluded.vertical,
           feed_only    = excluded.feed_only,
           poll_minutes = excluded.poll_minutes,
           updated_at   = excluded.updated_at`
      ).bind(handle,
             // Empty is meaningful: it means "use the name the account publishes", which is
             // right for anyone whose real name isn't worth hard-coding in a config file.
             typeof h.display_name === "string" ? h.display_name : "",
             h.scope || "national", h.vertical || "nfl", h.feed_only ? 1 : 0,
             // Null means the waking-hours cadence; see dueTiers.
             Number(h.poll_minutes) > 0 ? Math.round(Number(h.poll_minutes)) : null, now)
    );
  }
  if (stmts.length) await env.DB.batch(stmts);

  // The list is authoritative across every vertical, which is why the pipeline sends all of
  // them in one call: a handle that has dropped out — last week's opponent beat writer, most
  // often — must stop being polled, or the poll query grows by one handle a week and keeps
  // paying for tweets nobody asked for. Sending one vertical at a time here would delete the
  // other vertical's handles entirely, so pushing a partial list is never safe.
  const keep = handles.map(h => String(h.handle || "").toLowerCase()).filter(Boolean);
  if (keep.length) {
    const CHUNK = 90;
    let condition = "", binds = [];
    for (let i = 0; i < keep.length; i += CHUNK) {
      const slice = keep.slice(i, i + CHUNK);
      condition += `${condition ? " AND " : ""}handle NOT IN (${slice.map(() => "?").join(",")})`;
      binds = binds.concat(slice);
    }
    const gone = await env.DB.prepare(`DELETE FROM handles WHERE ${condition}`).bind(...binds).run();
    if (gone.meta?.changes) console.log(`dropped ${gone.meta.changes} handle(s) no longer watched`);
  }
  return stmts.length;
}

async function upsertAll(env, rawTweets, source) {
  if (!rawTweets.length) return { written: 0 };

  // Only store handles we actually track — a rule edit upstream must not silently widen the app.
  const known = await env.DB.prepare("SELECT handle FROM handles").all();
  const knownSet = new Set((known.results || []).map(r => r.handle));

  const now = new Date().toISOString();
  const cutoff = isoDaysAgo(RETENTION_DAYS);
  const stmts = [];
  for (const raw of rawTweets) {
    const t = normalize(raw, source);
    if (!t) continue;
    if (knownSet.size && !knownSet.has(t.author_handle.toLowerCase())) continue;
    if (t.published_at < cutoff) continue;
    // A reply to someone else is half a conversation the reader can't see, and beat writers
    // generate a lot of it. Replies to self are thread continuations and do belong.
    if (t.is_reply && !t.is_self_thread) continue;
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
  if (!stmts.length) return { written: 0 };
  await env.DB.batch(stmts);
  return { written: stmts.length };
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
 * and bills 15 credits for each of them, every five minutes. Never widen a window casually,
 * and never leave a mark standing still while its query keeps succeeding.
 *
 * Second, the per-request floor is what multiplies, not the handle count: one request covers
 * about 21 handles for the same ~26 credits. So within a feed the cheapest arrangement is one
 * cadence for everything — giving some of football's handles a slower tier would add queries
 * and pay the floor more times, for slower tweets.
 *
 * A whole vertical is different. Its handles fill queries of their own either way, so polling
 * those queries less often pays the floor fewer times and costs nothing else: the tweets are
 * billed once whenever they are collected. That is what `poll_minutes` on a handle is for, and
 * it is set per vertical in the pipeline's sources files, never per account.
 *
 * For reference, the filter-rule webhook this replaced billed 15 credits per rule per check
 * whether or not anything matched: 43,200 credits/day, ~$12.87/month of empty polling. The
 * rules in pipeline/rules.py are deactivated. Reactivating them re-arms that meter.
 */

// The API rejects a query longer than 512 characters, and has at times answered one with zero
// tweets and no error instead. Either failure is indistinguishable from a quiet news day, so
// the builder splits well short of the cliff and never emits a query that could trip it.
const POLL_QUERY_CHARS = 500;
// Pages one query may take in one poll; 25 x 20 = 500 tweets. It only binds after a long gap,
// and what lies past it is lost, so it is set well above a normal overnight.
const POLL_MAX_PAGES = 25;
// Pages the whole poll may take. A Worker invocation is allowed a fixed number of outbound
// requests and dies without a word when it runs out, so the poll stops itself first.
const POLL_PAGE_BUDGET = 40;
// Re-ask for a sliver we already hold. The search index can surface posts out of order, and a
// handful of duplicate tweets is far cheaper than a hole in the feed.
const POLL_OVERLAP_SEC = 120;
// Floor on the watermark, so a long outage can't trigger an unbounded — and expensive — crawl.
const POLL_MAX_LOOKBACK_H = 26;
// One more try for a request the API fumbled. It documents the occasional 503 as retryable and
// unbilled, and a single retry is the difference between a blip and a failed poll.
const SEARCH_RETRY_MS = 1500;
const POLL_LOG_KEEP_DAYS = 14;

/* Waking-hours cadence, in Eastern. Cloudflare crons are UTC-only and cannot express this, so
 * the cron fires every 5 minutes year-round and the gate lives here instead — which also means
 * the schedule stays correct across DST with no wrangler.toml edit. A gated-out invocation
 * makes no API call and costs nothing.
 *
 * Overnight is dark on purpose: nothing is lost, because the 8am poll's watermark reaches back
 * to the last tweet seen and pulls the whole night in. */
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

/* Which handles are due on this tick, grouped by how often they are polled.
 *
 * A handle with no `poll_minutes` rides the waking-hours cadence above. One with it set is
 * polled that often instead, and never faster than the hour allows, so a 30-minute vertical
 * stays at 30 through the day and the shoulders alike. */
function dueTiers(rows, cadence, hour, minute) {
  const groups = new Map();   // poll_minutes (0 = the waking-hours cadence) -> handle rows
  for (const row of rows) {
    if (!row.handle) continue;
    const own = Number(row.poll_minutes) > 0 ? Number(row.poll_minutes) : 0;
    if (!groups.has(own)) groups.set(own, []);
    groups.get(own).push(row);
  }
  const clock = hour * 60 + minute;
  const due = [];
  for (const [own, members] of groups) {
    const every = Math.max(cadence, own);
    if (clock % every === 0) due.push({ minutes: own, every, rows: members });
  }
  return due;
}

/* One poll: every due query, each with its own window and its own outcome.
 *
 * The queries are independent on purpose. Each resumes from the newest post the API has shown
 * for its own handles, and only moves that mark when it has read its window to the end — so a
 * query that fails, or a poll that dies halfway, costs nothing but a retry. Sharing one mark
 * across queries is how a failure in the third used to erase its handles' posts for good: the
 * first two had already stored something newer, and the next poll resumed from there. */
async function poll(env, now) {
  const { hour, minute } = easternParts(now);
  const cadence = pollCadenceMinutes(hour);
  if (cadence === 0) return;
  // The cron ticks every 5 minutes; a 15-minute cadence uses every third tick.
  const onCadence = minute % cadence === 0;

  if (!env.TWITTERAPI_IO_KEY) {
    if (!onCadence) return;
    return await recordPoll(env, now, { ok: false, error: "TWITTERAPI_IO_KEY not set" });
  }

  const rows = await env.DB.prepare(
    "SELECT handle, poll_minutes, seen_through FROM handles ORDER BY handle").all();
  const all = (rows.results || []).filter(r => r.handle);
  if (!all.length) {
    if (!onCadence) return;
    // The handles table is synced by the pipeline; empty means that sync never ran, and
    // polling with no handles would just burn the per-request floor for nothing.
    return await recordPoll(env, now, { ok: false, error: "no handles in D1 — run tweets.py --mode sync-handles" });
  }

  const tiers = dueTiers(all, cadence, hour, minute);
  if (!tiers.length) return;
  const jobs = tiers.flatMap(tier => buildPollJobs(tier, now));

  const tally = {
    pages: 0, returned: 0, written: 0, credits: 0,
    // Billed per tweet returned, so a handle's share of the bill is its share of these —
    // counted before dedupe, because a tweet already stored was still paid for again.
    byHandle: new Map(),
  };
  const errors = [];
  let truncated = false;
  for (const job of jobs) {
    try {
      const result = await runPollJob(env, job, tally);
      if (result.truncated) truncated = true;
      await markSeen(env, result.seen);
    } catch (err) {
      // This query's mark stays where it was, so the next poll asks for the same window
      // again. The rest of the queries still run: one bad request must not cost the others.
      console.error("poll query failed", err && err.stack ? err.stack : String(err));
      errors.push(`${job.handles[0]}…${job.handles[job.handles.length - 1]}: ` +
                  String(err && err.message ? err.message : err));
    }
  }

  const since = jobs.map(j => j.since).reduce((a, b) => (a < b ? a : b));
  if (truncated) console.warn("poll hit a page cap; a window was not fully covered");
  console.log(`poll: ${jobs.reduce((n, j) => n + j.handles.length, 0)} handles, ` +
              `${jobs.length} query(s), ${tally.pages} page(s), ${tally.returned} returned, ` +
              `${tally.written} written, ${errors.length} failed`);

  // Whatever came back was paid for, whether or not the poll as a whole succeeded. And never
  // let bookkeeping lose an ingest that already happened.
  try {
    await recordUsage(env, now, {
      polls: 1, requests: tally.pages, tweets: tally.returned, byHandle: tally.byHandle,
    });
  } catch (err) {
    console.error("usage record failed", err && err.stack ? err.stack : String(err));
  }

  await recordPoll(env, now, {
    ok: errors.length === 0,
    ...(errors.length ? { error: errors.join(" | ") } : {}),
    cadence_minutes: cadence,
    // The oldest window asked for, which is the one a reader of /health needs to see.
    since: since.toISOString(),
    handles: jobs.reduce((n, j) => n + j.handles.length, 0),
    queries: jobs.length, failed_queries: errors.length,
    pages: tally.pages, returned: tally.returned, written: tally.written,
    truncated, credits: tally.credits,
    tiers: tiers.map(t => ({ every_minutes: t.every, handles: t.rows.length })),
  });
}

/* A tier's handles, packed into as few queries as the length budget allows, each with the
 * window it should ask for. Grouping is purely by length, never by scope: the Worker routes on
 * the author's handle, so a query may freely span tabs, and fewer queries means the
 * per-request floor is paid fewer times.
 *
 * A query resumes from the newest post the API has returned for any of its handles — its
 * anchor — less a small overlap. Every handle in a query is read through the same poll, so the
 * newest of them is how far all of them have been read. The anchor is floored so a long gap
 * can never become an unbounded crawl, which is also where a query with nothing seen starts. */
function buildPollJobs(tier, now) {
  const floor = new Date(now.getTime() - POLL_MAX_LOOKBACK_H * 3600_000);
  // Sized for the suffix every query will carry; a Unix timestamp stays ten digits until 2286.
  const suffixFor = (since) => ` include:nativeretweets since_time:${Math.floor(since.getTime() / 1000)}`;
  const budget = POLL_QUERY_CHARS - suffixFor(floor).length - 2;  // the wrapping parens

  const groups = [];
  let group = [], length = 0;
  for (const row of tier.rows) {
    const term = `from:${row.handle}`;
    // A single handle wider than the whole budget can't be expressed; dropping it is bad, but
    // emitting an over-length query that fails for *every* handle is worse.
    if (term.length > budget) {
      console.warn(`poll: handle ${row.handle} too long for a query budget of ${budget}; skipped`);
      continue;
    }
    const addition = group.length ? term.length + 4 : term.length;  // " OR "
    if (group.length && length + addition > budget) {
      groups.push(group);
      group = []; length = 0;
    }
    group.push(row);
    length += group.length === 1 ? term.length : term.length + 4;
  }
  if (group.length) groups.push(group);

  return groups.map(members => {
    const newest = members.map(r => r.seen_through || "").reduce((a, b) => (a > b ? a : b), "");
    const seen = newest ? new Date(newest) : null;
    const anchor = seen && !isNaN(seen) && seen > floor ? seen : null;
    const since = anchor ? new Date(anchor.getTime() - POLL_OVERLAP_SEC * 1000) : floor;
    const handles = members.map(r => r.handle);
    return {
      handles, since,
      anchor: anchor ? anchor.toISOString() : null,
      query: `(${handles.map(h => `from:${h}`).join(" OR ")})${suffixFor(since)}`,
    };
  });
}

/* Read one query's window, newest first, until it is known to be finished.
 *
 * Knowing that is the hard part. A page holds up to 20 tweets but routinely fewer with more
 * still to come — the API filters ads out after it has counted — and `has_next_page` stays true
 * on a last page. Stopping at the first short page is what this used to do, and it silently
 * dropped everything older in any window that needed a second page: a busy half hour, a game,
 * the whole night before an 8am poll. Following `has_next_page` instead would pay the
 * per-request floor for an empty page on nearly every poll.
 *
 * The anchor settles it for free. The window is deliberately opened just before a post already
 * seen, so that post comes back at the old end of the results, and reaching it — or anything
 * as old — proves the window has been read through. Only a query with no anchor in reach has
 * to pay for the empty page that says so.
 *
 * Returns the newest post seen per handle, for the caller to record once the window is done.
 * A window cut short by a page cap is recorded too: the pages come newest first, so holding
 * the mark back would re-buy the same newest pages on every poll and never reach the rest. */
async function runPollJob(env, job, tally) {
  const seen = new Map();   // handle -> newest published_at returned
  let cursor = "", page = 0, finished = false;
  while (page < POLL_MAX_PAGES && tally.pages < POLL_PAGE_BUDGET) {
    const body = await searchPage(env, job.query, cursor);
    const tweets = Array.isArray(body.tweets) ? body.tweets : [];
    page += 1; tally.pages += 1;
    tally.returned += tweets.length;
    tally.credits += requestCredits(tweets.length);

    let reachedAnchor = false;
    for (const t of tweets) {
      const h = String(t?.author?.userName || "").toLowerCase();
      const at = toIso(t?.createdAt || t?.created_at);
      if (h) tally.byHandle.set(h, (tally.byHandle.get(h) || 0) + 1);
      if (h && at && at > (seen.get(h) || "")) seen.set(h, at);
      if (job.anchor && at && at <= job.anchor) reachedAnchor = true;
    }
    if (tweets.length) tally.written += (await upsertAll(env, tweets, "poll")).written;

    const next = body.next_cursor || "";
    if (!tweets.length || reachedAnchor || !body.has_next_page || !next || next === cursor) {
      finished = true;
      break;
    }
    cursor = next;
  }
  return { seen, truncated: !finished };
}

/* Move each handle's mark forward to the newest post the API returned for it — stored or not,
 * because a reply that is filtered out was still read, and a mark that ignored it would ask
 * for it, and pay for it, on every poll after. Never backward. */
async function markSeen(env, seen) {
  if (!seen.size) return;
  await env.DB.batch([...seen].map(([handle, at]) => env.DB.prepare(
    `UPDATE handles SET seen_through = ?
      WHERE handle = ? AND (seen_through IS NULL OR seen_through < ?)`
  ).bind(at, handle, at)));
}

async function searchPage(env, query, cursor) {
  const url = new URL(`${TWITTERAPI_BASE}/twitter/tweet/advanced_search`);
  url.searchParams.set("query", query);
  url.searchParams.set("queryType", "Latest");
  if (cursor) url.searchParams.set("cursor", cursor);
  const ask = () => fetch(url.toString(), { headers: { "X-API-Key": env.TWITTERAPI_IO_KEY } });
  let res = await ask();
  if (res.status === 429 || res.status >= 500) {
    await new Promise(resolve => setTimeout(resolve, SEARCH_RETRY_MS));
    res = await ask();
  }
  if (!res.ok) throw new Error(`advanced_search returned ${res.status}`);
  return await res.json();
}

/* A poll that finds nothing and a poll that quietly broke look identical from the outside, so
 * every run leaves a record. /health reports the last one, and the log behind it is what shows
 * a bad afternoon after the fact: the last poll alone is overwritten five minutes later, which
 * is how three days of failing polls once left no trace of why. */
async function recordPoll(env, now, detail) {
  if (!detail.ok) console.error("poll not ok:", JSON.stringify(detail));
  const at = now.toISOString();
  const value = JSON.stringify({ at, ...detail });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES ('last_poll', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(value, at),
    env.DB.prepare(
      `INSERT INTO poll_log (at, ok, detail) VALUES (?, ?, ?)
       ON CONFLICT(at) DO UPDATE SET ok = excluded.ok, detail = excluded.detail`
    ).bind(at, detail.ok ? 1 : 0, value),
  ]);
}

/* ---------- usage ---------- */

/* What the polling actually cost, so the decision to add a handle or change the cadence is
 * made against real numbers instead of an estimate. twitterapi.io reports nothing — no billing
 * endpoint, no cost header — so this is the only record that exists. */
async function recordUsage(env, now, { polls, requests, tweets, byHandle }) {
  const day = easternDay(now);
  const writes = [
    env.DB.prepare(
      `INSERT INTO usage_daily (day, polls, requests, tweets) VALUES (?,?,?,?)
       ON CONFLICT(day) DO UPDATE SET
         polls = polls + excluded.polls,
         requests = requests + excluded.requests,
         tweets = tweets + excluded.tweets`
    ).bind(day, polls, requests, tweets),
  ];
  for (const [handle, count] of byHandle || []) {
    writes.push(env.DB.prepare(
      `INSERT INTO usage_handle_daily (day, handle, tweets) VALUES (?,?,?)
       ON CONFLICT(day, handle) DO UPDATE SET tweets = tweets + excluded.tweets`
    ).bind(day, handle, count));
  }
  await env.DB.batch(writes);
}

/* The month to date, the daily series behind it, and what each handle contributed.
 *
 * Public, like /health. It reveals what this app spends and who it watches, which is not a
 * secret; the alternative is a token the app would have to hold, and a static site has nowhere
 * safe to keep one. */
async function usage(env, url, origin) {
  const now = new Date();
  const month = (url.searchParams.get("month") || easternDay(now).slice(0, 7)).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: "bad month" }, 400, env, origin);

  const [daysRes, handlesRes, watched] = await Promise.all([
    env.DB.prepare(
      `SELECT day, polls, requests, tweets FROM usage_daily
        WHERE day LIKE ? ORDER BY day`
    ).bind(`${month}-%`).all(),
    env.DB.prepare(
      `SELECT handle, SUM(tweets) AS tweets FROM usage_handle_daily
        WHERE day LIKE ? GROUP BY handle ORDER BY tweets DESC`
    ).bind(`${month}-%`).all(),
    env.DB.prepare("SELECT handle, display_name, scope FROM handles").all(),
  ]);

  const days = (daysRes.results || []).map(r => ({
    day: r.day, polls: r.polls, requests: r.requests, tweets: r.tweets,
    usd: dayUsd(r.requests, r.tweets),
  }));
  const totals = days.reduce((acc, d) => ({
    polls: acc.polls + d.polls, requests: acc.requests + d.requests,
    tweets: acc.tweets + d.tweets, usd: acc.usd + d.usd,
  }), { polls: 0, requests: 0, tweets: 0, usd: 0 });

  // A month is only worth projecting from days that actually happened; today is still running,
  // so it is counted in the spend but not in the divisor.
  const elapsed = Math.max(1, days.length);
  const inMonth = daysInMonth(month);
  const perDay = totals.usd / elapsed;

  const meta = new Map((watched.results || []).map(r => [String(r.handle).toLowerCase(), r]));
  const rows = (handlesRes.results || []).map(r => {
    const info = meta.get(String(r.handle).toLowerCase());
    return {
      handle: r.handle,
      display_name: info?.display_name || r.handle,
      scope: info?.scope || null,
      watched: Boolean(info),
      tweets: r.tweets,
      // Tweets are billed per tweet, so this share is exact. The per-request floor is a
      // property of the schedule, not of any handle, and is reported separately below.
      usd: round4((r.tweets * CREDITS_PER_TWEET) / CREDITS_PER_USD),
    };
  });
  const tweetUsd = round4((totals.tweets * CREDITS_PER_TWEET) / CREDITS_PER_USD);

  return json({
    month,
    days,
    month_to_date: {
      ...totals, usd: round4(totals.usd),
      days_elapsed: elapsed, days_in_month: inMonth,
      projected_usd: round4(perDay * inMonth),
      tweet_usd: tweetUsd,
      // Whatever the tweets did not account for is the price of asking at all.
      schedule_usd: round4(Math.max(0, totals.usd - tweetUsd)),
    },
    handles: rows,
    cadence: projectCadence(totals, elapsed, (watched.results || []).length),
    pricing: {
      credits_per_request_floor: CREDITS_PER_REQUEST_FLOOR,
      credits_per_tweet: CREDITS_PER_TWEET,
      credits_per_usd: CREDITS_PER_USD,
      note: "Computed, not billed. twitterapi.io publishes no usage API.",
    },
  }, 200, env, origin, { "Cache-Control": "public, max-age=300" });
}

/* What a different polling cadence would cost at the tweet volume actually observed.
 *
 * The tweets themselves cost the same however often they are collected — the same posts get
 * fetched either way. What changes is how many requests it takes, and how many of those come
 * back nearly empty and pay the floor for nothing. */
function projectCadence(totals, elapsed, handleCount) {
  const tweetsPerDay = totals.tweets / elapsed;
  // The poll runs 9am-7pm at full cadence and 8-9am plus 7-11pm at a third of it; overnight it
  // sleeps. This is that schedule expressed as waking minutes.
  const WAKING_MINUTES = 10 * 60 + 5 * 60;
  const queriesPerPoll = Math.max(1, Math.ceil(handleCount / 21));
  return [1, 5, 10, 15].map(minutes => {
    const polls = WAKING_MINUTES / minutes;
    const requests = polls * queriesPerPoll;
    const perRequest = tweetsPerDay / Math.max(1, requests);
    const perDay = requests * Math.max(CREDITS_PER_REQUEST_FLOOR, perRequest * CREDITS_PER_TWEET);
    return { minutes, requests_per_day: Math.round(requests),
             usd_per_month: round4((perDay / CREDITS_PER_USD) * 30) };
  });
}

function dayUsd(requests, tweets) {
  // Reconstructing per-request cost from daily totals assumes the tweets arrived evenly across
  // the day's requests. Real days are lumpier, which makes this a slight underestimate on the
  // quiet end — the floor binds on more requests than an average implies.
  const per = requests ? tweets / requests : 0;
  return (requests * Math.max(CREDITS_PER_REQUEST_FLOOR, per * CREDITS_PER_TWEET)) / CREDITS_PER_USD;
}

function easternDay(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function daysInMonth(month) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/* ---------- injury reports ---------- */

const INJURY_KEEP_DAYS = 30;
const INJURY_BATCH = 50;

/* A day's snapshot from the pipeline. Replaces that day rather than adding to it, so a rerun
 * corrects the day instead of leaving yesterday's answer beside today's. */
async function putInjuries(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!timingSafeEqual(token, env.PUSH_SECRET || "")) {
    return json({ error: "unauthorized" }, 401, env, "");
  }
  const body = await request.json().catch(() => null);
  const day = body && String(body.day || "");
  const rows = body && Array.isArray(body.rows) ? body.rows : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || "") || !rows) {
    return json({ error: "expected {day: YYYY-MM-DD, rows: []}" }, 400, env, "");
  }
  // An empty day is never written. Out of season the page is blank, and storing that would
  // erase a grid that is still the current one.
  if (!rows.length) return json({ ok: true, day, stored: 0, skipped: "empty" }, 200, env, "");

  const teams = [...new Set(rows.map(r => String(r.team || "")).filter(Boolean))];
  for (let i = 0; i < teams.length; i += 20) {
    const slice = teams.slice(i, i + 20);
    await env.DB.prepare(
      `DELETE FROM injury_reports WHERE day = ? AND team IN (${slice.map(() => "?").join(",")})`
    ).bind(day, ...slice).run();
  }

  let stored = 0;
  for (let i = 0; i < rows.length; i += INJURY_BATCH) {
    const slice = rows.slice(i, i + INJURY_BATCH);
    await env.DB.batch(slice.map(r => env.DB.prepare(
      `INSERT INTO injury_reports (day, team, player, position, injury, practice, status)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(day, team, player) DO UPDATE SET
         position = excluded.position, injury = excluded.injury,
         practice = excluded.practice, status = excluded.status`
    ).bind(day, String(r.team || ""), String(r.player || ""), str(r.position),
           str(r.injury), str(r.practice), str(r.status))));
    stored += slice.length;
  }

  await env.DB.prepare("DELETE FROM injury_reports WHERE day < ?")
    .bind(isoDaysAgo(INJURY_KEEP_DAYS).slice(0, 10)).run();

  return json({ ok: true, day, stored, teams: teams.length }, 200, env, "");
}

/* The week assembled: one row per player, with a column for each day that has a report. */
async function getInjuries(env, url, origin) {
  const teams = (url.searchParams.get("teams") || "")
    .split(",").map(t => t.trim().toUpperCase()).filter(Boolean).slice(0, 8);
  if (!teams.length) return json({ error: "teams= required" }, 400, env, origin);
  const days = Math.min(21, Math.max(1, Number(url.searchParams.get("days")) || 8));
  // An explicit `since` is how the caller says "this game week only" — a fixed window would
  // put last Wednesday's column beside this Wednesday's.
  const asked = url.searchParams.get("since") || "";
  const since = /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : isoDaysAgo(days).slice(0, 10);

  const res = await env.DB.prepare(
    `SELECT day, team, player, position, injury, practice, status
       FROM injury_reports
      WHERE day >= ? AND team IN (${teams.map(() => "?").join(",")})
      ORDER BY team, player, day`
  ).bind(since, ...teams).all();

  const seenDays = new Set();
  const byTeam = {};
  for (const r of res.results || []) {
    seenDays.add(r.day);
    const team = (byTeam[r.team] ||= new Map());
    let entry = team.get(r.player);
    if (!entry) {
      entry = { player: r.player, position: r.position, injury: r.injury,
                practice: {}, status: "" };
      team.set(r.player, entry);
    }
    if (r.practice) entry.practice[r.day] = r.practice;
    // The later day wins: a designation is set on Friday and supersedes a blank Wednesday.
    if (r.status) entry.status = r.status;
    if (r.injury) entry.injury = r.injury;
    if (r.position) entry.position = r.position;
  }

  return json({
    days: [...seenDays].sort(),
    teams: Object.fromEntries(teams.map(t => [t, [...(byTeam[t] || new Map()).values()]])),
  }, 200, env, origin, { "Cache-Control": "public, max-age=300" });
}

function str(v) {
  return v == null ? "" : String(v);
}

/* ---------- read path ---------- */

async function getTweets(request, env, url, origin) {
  const scope = url.searchParams.get("scope") || "";
  const vertical = url.searchParams.get("vertical") || "";
  const handle = (url.searchParams.get("handle") || "").toLowerCase().replace(/^@/, "");
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
  // A feed asks by vertical; its scopes are then filtered in the app, which already has to do
  // that to split one vertical's feed into tabs.
  if (vertical) { sql += " AND h.vertical = ?"; binds.push(vertical); }
  if (scope) { sql += " AND h.scope = ?"; binds.push(scope); }
  // By author, for the dossier's beat-writer box: this week's opponent may also be a rival
  // watched year-round, in which case their scope is `rivals` and asking by scope finds
  // nothing.
  if (handle) { sql += " AND LOWER(t.author_handle) = ?"; binds.push(handle); }
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

  const last = page.length ? page[page.length - 1] : null;
  const newest = items.length ? items[0].published_at : null;
  return json(
    { schema_version: 2, generated_at: new Date().toISOString(), newest_tweet_at: newest,
      scope: scope || "all", vertical: vertical || "all",
      window_hours: hours, count: items.length, items,
      next_cursor: hasMore && last ? makeCursor(last.published_at, last.id) : null },
    200, env, origin,
    // Short edge cache: keeps a burst of app opens off D1 without making tweets feel stale.
    { "Cache-Control": "public, max-age=30" }
  );
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
  const day = await env.DB.prepare(
    `SELECT COUNT(*) AS polls, SUM(ok = 0) AS failed FROM poll_log WHERE at >= ?`
  ).bind(isoDaysAgo(1)).first();
  const lastFailure = await env.DB.prepare(
    "SELECT detail FROM poll_log WHERE ok = 0 ORDER BY at DESC LIMIT 1"
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
    handles: handles?.n ?? 0,
    newest_tweet_at: row?.newest ?? null,
    last_ingest_at: row?.last_ingest ?? null,
    by_source: Object.fromEntries((bySource.results || []).map(r => [r.source, r.n])),
    retention_days: RETENTION_DAYS,
    // The ingest path's own report card — see recordPoll().
    last_poll: safeParse(lastPoll?.value, null),
    // One good poll says nothing about the hundred before it. A day in which some polls
    // failed is a day with holes in the feed, and this is the only place that shows.
    polls_24h: { total: day?.polls ?? 0, failed: day?.failed ?? 0 },
    last_failed_poll: safeParse(lastFailure?.detail, null),
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
 * near-always-zero wrapper, and the post that one quotes in turn. */
function extractTweetRef(t, depth = 0) {
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
    // A reposted quote-post is only half there without the post it quotes. One level and no
    // further: a quote inside a quote is not shown by Twitter either.
    quoted: depth === 0 ? extractTweetRef(t.quoted_tweet || t.quotedTweet, 1) : null,
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

/* Outbound links, in the order they appear in the text, which is the order the app relies on
 * to put each one back where its t.co stub stands. `expanded_url` is the real destination. A
 * link to a post on Twitter itself is left out: that is the quote or the media, which the app
 * renders in its own right. Anything else there — an article, a broadcast — is a destination
 * like any other. */
function extractLinks(raw) {
  const entities = raw.entities || {};
  const urls = [].concat(entities.urls || [], (entities.url && entities.url.urls) || []);
  const out = [];
  for (const u of urls) {
    const expanded = String(u.expanded_url || u.expandedUrl || u.url || "");
    if (!/^https?:\/\//i.test(expanded)) continue;
    const host = safeHost(expanded);
    if (!host || host === "t.co") continue;
    const onTwitter = /(^|\.)(twitter|x)\.com$/.test(host);
    if (onTwitter && /\/status(es)?\/\d+/.test(expanded)) continue;
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
      out.push({ type, url: poster, video_url: vurl, loop: type === "animated_gif", ...shape(m, vurl) });
    } else if (poster) {
      out.push({ type, url: poster, ...shape(m, poster) });
    }
  }
  return out;
}

/* The shape of the media, so the app can reserve its box before anything downloads. Without it
 * a player is 2:1 until its poster arrives and then jumps to the real proportions, which moves
 * every tweet below it — under a thumb that was already reaching for one of them.
 *
 * Twitter reports the size three different ways depending on which endpoint answered, and the
 * mp4's own path carries it when none of them do. */
function shape(m, url) {
  const vi = m.video_info || m.videoInfo || {};
  const ratio = vi.aspect_ratio || vi.aspectRatio || [];
  const original = m.original_info || m.originalInfo || {};
  const large = (m.sizes && (m.sizes.large || m.sizes.medium)) || {};
  const candidates = [
    [ratio[0], ratio[1]],
    [original.width, original.height],
    [large.w, large.h],
    dimsFromUrl(url),
  ];
  for (const [w, h] of candidates) {
    if (Number(w) > 0 && Number(h) > 0) return { w: Number(w), h: Number(h) };
  }
  return {};
}

/* video.twimg.com puts the rendition size in the path: .../vid/avc1/1280x720/name.mp4 */
function dimsFromUrl(url) {
  const hit = /\/(\d{2,4})x(\d{2,4})\//.exec(String(url || ""));
  return hit ? [Number(hit[1]), Number(hit[2])] : [0, 0];
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
