/* NFL Daily tweet store.
 *
 * Tweets reach the app two ways and both land in the same D1 table, keyed by tweet id:
 *
 *   twitterapi.io webhook  -> POST /ingest   (seconds after the tweet, may be a thin payload)
 *   pipeline sweep         -> POST /push     (hourly + daily, always full tweet objects)
 *
 * The webhook gives immediacy; the sweep gives completeness and the rich fields (media,
 * quoted posts) that a thin webhook payload may omit. `richness` decides upsert conflicts so
 * the fuller record always wins regardless of arrival order.
 *
 * The PWA reads GET /tweets. Handle -> scope routing lives in D1, synced from sources.yaml by
 * the pipeline, so adding a handle never requires redeploying this Worker.
 */

const RETENTION_DAYS = 7;
const MAX_LIMIT = 500;
const DEFAULT_HOURS = 48;

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

  // Prune on a schedule rather than on every write, so an ingest burst stays cheap.
  async scheduled(event, env) {
    const cutoff = isoDaysAgo(RETENTION_DAYS);
    const res = await env.DB.prepare("DELETE FROM tweets WHERE published_at < ?").bind(cutoff).run();
    console.log(`pruned ${res.meta?.changes ?? 0} tweets older than ${cutoff}`);
  },
};

/* ---------- write paths ---------- */

// twitterapi.io authenticates its webhook by sending our own API key back to us in X-API-Key.
async function ingest(request, env) {
  if (!timingSafeEqual(request.headers.get("X-API-Key") || "", env.TWITTERAPI_IO_KEY || "")) {
    return json({ error: "unauthorized" }, 401, env, "");
  }
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "bad json" }, 400, env, "");

  const raw = Array.isArray(body.tweets) ? body.tweets : (body.tweet ? [body.tweet] : []);
  const written = await upsertAll(env, raw, "webhook");
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
  const source = body.source === "backstop" ? "backstop" : "search";
  const written = await upsertAll(env, raw, source);
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

async function upsertAll(env, rawTweets, source) {
  if (!rawTweets.length) return 0;

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
        `INSERT INTO tweets (id, author_handle, author_name, text, url, published_at,
                             is_retweet, is_reply, is_self_thread, rt_author, media, quoted,
                             richness, source, ingested_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           author_name    = excluded.author_name,
           text           = excluded.text,
           url            = excluded.url,
           published_at   = excluded.published_at,
           is_retweet     = excluded.is_retweet,
           is_reply       = excluded.is_reply,
           is_self_thread = excluded.is_self_thread,
           rt_author      = excluded.rt_author,
           media          = excluded.media,
           quoted         = excluded.quoted,
           richness       = excluded.richness,
           source         = excluded.source
         WHERE excluded.richness >= tweets.richness`
      ).bind(t.id, t.author_handle, t.author_name, t.text, t.url, t.published_at,
             t.is_retweet, t.is_reply, t.is_self_thread, t.rt_author,
             JSON.stringify(t.media), t.quoted ? JSON.stringify(t.quoted) : null,
             t.richness, source, now)
    );
  }
  if (!stmts.length) return 0;
  await env.DB.batch(stmts);
  return stmts.length;
}

/* ---------- read path ---------- */

async function getTweets(request, env, url, origin) {
  const scope = url.searchParams.get("scope") || "";
  const hours = clampInt(url.searchParams.get("hours"), DEFAULT_HOURS, 1, 24 * RETENTION_DAYS);
  const limit = clampInt(url.searchParams.get("limit"), MAX_LIMIT, 1, MAX_LIMIT);
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  // Scope lives on the handles table, so a routing change takes effect without a rewrite here.
  let sql =
    `SELECT t.id, t.author_handle, t.author_name, t.text, t.url, t.published_at,
            t.is_retweet, t.is_reply, t.is_self_thread, t.rt_author, t.media, t.quoted,
            h.scope, h.display_name
       FROM tweets t JOIN handles h ON h.handle = LOWER(t.author_handle)
      WHERE t.published_at >= ?`;
  const binds = [since];
  if (scope) { sql += " AND h.scope = ?"; binds.push(scope); }
  sql += " ORDER BY t.published_at DESC LIMIT ?";
  binds.push(limit);

  const rows = await env.DB.prepare(sql).bind(...binds).all();
  const items = (rows.results || []).map(r => ({
    id: r.id,
    type: "tweet",
    scopes: [r.scope],
    source_id: `twitter_${r.author_handle}`,
    source_name: r.display_name || r.author_name || r.author_handle,
    author_handle: r.author_handle,
    author_name: r.display_name || r.author_name || r.author_handle,
    text: r.text,
    url: r.url,
    published_at: r.published_at,
    is_retweet: !!r.is_retweet,
    is_self_thread: !!r.is_self_thread,
    rt_author: r.rt_author || null,
    media: safeParse(r.media, []),
    quoted: safeParse(r.quoted, null),
  }));

  const newest = items.length ? items[0].published_at : null;
  return json(
    { schema_version: 1, generated_at: new Date().toISOString(), newest_tweet_at: newest,
      scope: scope || "all", window_hours: hours, count: items.length, items },
    200, env, origin,
    // Short edge cache: keeps a burst of app opens off D1 without making tweets feel stale.
    { "Cache-Control": "public, max-age=30" }
  );
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
  return json({
    ok: true,
    tweets: row?.n ?? 0,
    handles: handles?.n ?? 0,
    newest_tweet_at: row?.newest ?? null,
    last_ingest_at: row?.last_ingest ?? null,
    by_source: Object.fromEntries((bySource.results || []).map(r => [r.source, r.n])),
    retention_days: RETENTION_DAYS,
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
  // Full REST objects carry the fields that make a card worth rendering; a thin webhook
  // payload does not. Mark which one this is so the fuller record wins the upsert.
  const richness = ("extendedEntities" in raw || "extended_entities" in raw) ? 1 : 0;

  return {
    id,
    author_handle: handle,
    author_name: decodeEntities(String(author.name || handle)),
    text,
    url: String(raw.url || `https://twitter.com/${handle}/status/${id}`),
    published_at: published,
    is_retweet: isRetweet ? 1 : 0,
    is_reply: isReply ? 1 : 0,
    is_self_thread: isSelfThread ? 1 : 0,
    rt_author: rt ? String((rt.author || {}).userName || (rt.author || {}).username || "") : null,
    media,
    quoted: extractQuoted(raw),
    richness,
  };
}

function extractQuoted(raw) {
  const q = raw.quoted_tweet || raw.quotedTweet;
  if (!q || typeof q !== "object") return null;
  const author = q.author || {};
  const handle = String(author.userName || author.username || "");
  const text = decodeEntities(String(q.text || "").trim());
  const media = extractMedia(q);
  if (!text && !media.length) return null;
  return {
    author_handle: handle,
    author_name: decodeEntities(String(author.name || handle)),
    text,
    url: String(q.url || (handle && q.id ? `https://twitter.com/${handle}/status/${q.id}` : "")),
    published_at: toIso(q.createdAt || q.created_at),
    media,
  };
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
