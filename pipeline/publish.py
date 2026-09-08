#!/usr/bin/env python3
"""Transform a run log into the app's JSON data files.

Reads:  a run log (default: newest runtime/runs/*.json) + config/sources.yaml
Writes: web/data/config.json, web/data/feed.json, web/data/digest.json

Usage:
  python3 pipeline/publish.py                 # newest run log
  python3 pipeline/publish.py --run PATH      # specific run log
  python3 pipeline/publish.py --out DIR       # output dir (default: <repo>/web/data)
"""

import argparse
import glob
import hashlib
import html
import json
import math
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

try:
    import yaml
except ImportError:
    yaml = None

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_RUNTIME = os.path.expanduser(os.environ.get("NFL_DAILY_RUNTIME", os.path.join(REPO_ROOT, "runtime")))
DEFAULT_RUNS_DIR = os.path.join(_RUNTIME, "runs")
DEFAULT_SOURCES = os.path.expanduser(
    os.environ.get("NFL_DAILY_SOURCES", os.path.join(REPO_ROOT, "config", "sources.yaml")))

SCHEMA_VERSION = 1

# Articles stay in the app's Articles tab this many hours (wider than the 24h digest window
# so Matt can catch up on articles he didn't read the day they dropped). Override with
# NFL_DAILY_ARTICLE_WINDOW_HOURS.
ARTICLE_WINDOW_HOURS = 48

# Source rank published on every article as `source_rank` when sources.yaml doesn't set one.
# High enough that an unranked source always sorts below a ranked one and loses every cluster.
DEFAULT_SOURCE_RANK = 99

# Every rival team shares one scope. Matt checks these teams once or twice a week; a tab each
# would be five near-empty rooms, and the point is keeping half an eye on them together.
RIVALS_SCOPE = "rivals"

TEAM_CODES = {
    "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL",
    "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
    "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL",
    "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
    "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
    "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC",
    "Los Angeles Rams": "LAR", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN",
    "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
    "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT",
    "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB",
    "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
}

STRUCTURED_TYPE_BY_SOURCE = {
    "espn_transactions": "transaction",
    "nfl_com_transactions": "transaction",
    "espn_injuries": "injury",
    "nfl_com_injuries": "injury",
}


def clean_text(value):
    """Undo the HTML entity escaping publishers leave in feed content.

    RSS descriptions arrive with `&#8217;` for an apostrophe and Twitter serves tweet text with
    `&amp;` for an ampersand. The app escapes once at render time, so an entity that survives
    to here gets escaped a second time and reaches the screen as a literal "&amp;".
    Unescaping twice is deliberate: some feeds double-encode (`&amp;#8217;`).
    """
    if not value or not isinstance(value, str):
        return value
    out = html.unescape(html.unescape(value))
    # Feeds occasionally carry a stray NUL or control char that breaks JSON consumers.
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", out)


def parse_dt(value):
    """Parse the run logs' assorted ISO-ish date strings to aware UTC datetimes."""
    if not value or not isinstance(value, str):
        return None
    v = value.strip()
    # Normalize trailing Z and missing seconds ("2026-07-24T07:00Z")
    v = re.sub(r"Z$", "+00:00", v)
    if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\+", v):
        v = v.replace("+", ":00+", 1) if v.count("+") == 1 else v
    try:
        dt = datetime.fromisoformat(v)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def find_team(text):
    """Return (code, name) for the first full team name found in text, else (None, None)."""
    if not text:
        return None, None
    for name, code in TEAM_CODES.items():
        if name in text:
            return code, name
    return None, None


def resolve_team(item):
    """Team code for a structured item. Prefer the fetcher's authoritative `team` field
    (ESPN sets the transacting/injured team explicitly); fall back to scanning the title
    only when it's absent (e.g. NFL.com pages). Avoids mis-tagging a transaction that
    mentions a second team (e.g. 'Steelers claim WR from Cardinals' → PIT, not ARI)."""
    code = TEAM_CODES.get(item.get("team") or "")
    if code:
        return code
    return find_team(item.get("title"))[0]


def item_id(*parts):
    h = hashlib.sha1("|".join(str(p) for p in parts).encode("utf-8")).hexdigest()
    return h[:16]


# Refuse to publish if more than this fraction of sources errored (suspected mass failure).
MAX_SOURCE_ERROR_RATE = 0.5


def publish_ok(items, health_list):
    """(ok, reason) — is this run healthy enough to overwrite the live data?"""
    if not items:
        return False, "0 items in window (empty or failed run)"
    statuses = [str(h.get("status", "")) for h in (health_list or [])]
    if statuses:
        errors = sum(1 for s in statuses if s == "error")
        rate = errors / len(statuses)
        if rate > MAX_SOURCE_ERROR_RATE:
            return False, f"{errors}/{len(statuses)} sources errored ({rate:.0%}) — suspected mass fetch failure"
    return True, ""


def load_sources_config(path):
    if yaml is None:
        raise SystemExit("pyyaml is required (python3 -m pip install pyyaml)")
    with open(path) as f:
        cfg = yaml.safe_load(f)
    tc = cfg.get("team_coverage", {})
    primary = tc.get("primary", {})
    rivals = tc.get("rivals", []) or []
    # source_id -> display name, for attribution on cards
    names = {}
    # source_id -> rank (lower = higher priority). Drives the app's Ravens-tab sort and
    # decides which article survives when duplicates are clustered.
    ranks = {}

    def walk(node):
        if isinstance(node, dict):
            if "id" in node and "name" in node:
                names[node["id"]] = node["name"]
            if "id" in node and isinstance(node.get("rank"), int):
                ranks[node["id"]] = node["rank"]
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(cfg)
    return primary, rivals, names, ranks


def article_scopes(source_id, tracked_rival_codes):
    if source_id.startswith("ravens_"):
        return ["BAL"]
    m = re.match(r"rival_([a-z]{2,3})_", source_id)
    if m:
        code = m.group(1).upper()
        return [RIVALS_SCOPE] if code in tracked_rival_codes else ["national"]
    return ["national"]


# ---- article clustering -------------------------------------------------------------------
#
# The same story runs at ESPN, CBS and FOX; the app should show it once. Titles are the only
# signal available — there is no LLM and no API call here, because this runs in the hourly
# GitHub Actions job with no credentials and no budget.
#
# Every threshold below is tuned to UNDER-merge. A missed merge shows Matt a story twice, which
# he barely notices; a wrong merge hides an article from him entirely, which he can never
# discover. When in doubt, keep both.

# Two articles more than this far apart are different stories even with near-identical titles
# (a Thursday injury report and the Sunday follow-up).
CLUSTER_WINDOW_HOURS = 36
# Weighted-Jaccard floor: the shared share of both titles' total weight.
CLUSTER_MIN_JACCARD = 0.50
# Escape hatch for a long headline and a short one about the same story, where Jaccard is
# unfairly punished by the length gap. Deliberately strict.
CLUSTER_MIN_OVERLAP = 0.72
CLUSTER_OVERLAP_MIN_SHARED = 4
# Floor on raw shared tokens — two words in common is a coincidence, not a story match.
CLUSTER_MIN_SHARED = 3
# ...at least this many of which must be distinctive (rare across the scope's articles), so a
# match can't be carried by "ravens", "nfl", "week".
CLUSTER_MIN_DISTINCTIVE = 2

# Dropped before comparison: function words plus the sports-page filler that appears in a large
# share of headlines and carries no story identity.
_CLUSTER_STOPWORDS = {
    "a", "about", "after", "against", "all", "amid", "an", "and", "any", "are", "as", "at",
    "be", "been", "before", "being", "but", "by", "can", "could", "did", "do", "does", "down",
    "during", "each", "for", "from", "get", "gets", "had", "has", "have", "he", "her", "here",
    "him", "his", "how", "if", "in", "into", "is", "it", "its", "just", "may", "might", "more",
    "most", "much", "must", "my", "new", "no", "not", "now", "of", "off", "on", "one", "only",
    "or", "other", "our", "out", "over", "own", "per", "said", "says", "she", "should", "so",
    "some", "still", "such", "than", "that", "the", "their", "them", "then", "there", "these",
    "they", "this", "those", "to", "too", "two", "under", "up", "upon", "us", "very", "via",
    "was", "we", "were", "what", "when", "where", "which", "while", "who", "why", "will",
    "with", "would", "you", "your",
    # sports-page filler
    "nfl", "football", "news", "report", "reports", "update", "updates", "season", "game",
    "games", "week", "team", "teams", "player", "players", "day", "says",
}


def normalize_title_tokens(title):
    """Title → set of significant tokens. Lowercased, depunctuated, stopwords removed."""
    if not title:
        return set()
    text = title.lower().replace("’", "'")
    text = re.sub(r"'s\b", "", text)          # possessives: "ravens' " / "ravens's" → "ravens"
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return {w for w in text.split() if len(w) > 1 and w not in _CLUSTER_STOPWORDS}


def canonical_url(url):
    """URL stripped to the part that identifies the story: no scheme, query, fragment or
    trailing slash. Two articles at the same canonical URL are the same story, always."""
    if not url:
        return None
    try:
        parts = urlsplit(url.strip())
        host = (parts.netloc or "").lower().removeprefix("www.")
        path = (parts.path or "").rstrip("/").lower()
        return f"{host}{path}" or None
    except ValueError:
        return None


def _weighted_overlap(a_tokens, b_tokens, weights):
    """(weighted_jaccard, weighted_overlap_coefficient, shared_tokens)."""
    shared = a_tokens & b_tokens
    if not shared:
        return 0.0, 0.0, shared
    w_shared = sum(weights[t] for t in shared)
    w_a = sum(weights[t] for t in a_tokens)
    w_b = sum(weights[t] for t in b_tokens)
    w_union = w_a + w_b - w_shared
    jaccard = w_shared / w_union if w_union else 0.0
    smaller = min(w_a, w_b)
    overlap = w_shared / smaller if smaller else 0.0
    return jaccard, overlap, shared


def cluster_articles(items):
    """Collapse articles covering the same story. Returns (items, merged_count).

    Survivors keep every field they had plus `cluster_size`; the articles they absorbed are
    dropped from the feed with no trace, per the product spec (no "also covered by" line).
    Non-article items pass through untouched, always with cluster_size 1.

    Clustering is leader-based rather than single-linkage: candidates are visited best-source
    first, and each either starts a cluster or joins the single best existing one. That makes
    the highest-ranked source the survivor by construction, and stops A~B~C chaining A and C
    together when they aren't alike at all.
    """
    articles = [i for i in items if i["type"] == "article"]
    others = [i for i in items if i["type"] != "article"]
    for it in others:
        it["cluster_size"] = 1
    if len(articles) < 2:
        for it in articles:
            it["cluster_size"] = 1
        return items, 0

    tokens = {id(a): normalize_title_tokens(a.get("title")) for a in articles}
    published = {id(a): parse_dt(a.get("published_at")) for a in articles}

    # Inverse document frequency over this run's articles: a token in many headlines
    # ("ravens" in the Ravens scope) proves much less than a surname does.
    doc_freq = {}
    for a in articles:
        for tok in tokens[id(a)]:
            doc_freq[tok] = doc_freq.get(tok, 0) + 1
    total = len(articles)
    weights = {tok: math.log(1 + total / df) for tok, df in doc_freq.items()}
    # "Distinctive" = rare in this run. The absolute floor of 3 matters on small runs: a story
    # three outlets all covered gives its key tokens df=3, and a stricter floor would refuse to
    # merge the third copy purely because the run was quiet.
    distinctive_max_df = max(3, int(total * 0.12))
    distinctive = {tok for tok, df in doc_freq.items() if df <= distinctive_max_df}

    # Best source first, then newest — the leader of each cluster is the article that survives.
    # Two stable passes rather than one key, because the two fields sort in opposite
    # directions: best source wins, and among equals the newest telling of the story leads.
    order = sorted(articles, key=lambda a: a.get("published_at") or "", reverse=True)
    order.sort(key=lambda a: a.get("source_rank", DEFAULT_SOURCE_RANK))

    leaders_by_scope = {}   # scope key -> list of leader articles
    members = {}            # id(leader) -> count
    absorbed = set()        # id() of articles dropped from the feed

    for cand in order:
        scope_key = tuple(sorted(cand.get("scopes") or []))
        cand_tokens = tokens[id(cand)]
        cand_url = canonical_url(cand.get("url"))
        cand_dt = published[id(cand)]

        best_leader, best_score = None, 0.0
        for leader in leaders_by_scope.get(scope_key, []):
            # Identical URL is the same story no matter what the titles say.
            if cand_url and cand_url == canonical_url(leader.get("url")):
                best_leader, best_score = leader, 1.0
                break
            leader_dt = published[id(leader)]
            if cand_dt and leader_dt:
                if abs((cand_dt - leader_dt).total_seconds()) > CLUSTER_WINDOW_HOURS * 3600:
                    continue
            if not cand_tokens:
                continue
            jaccard, overlap, shared = _weighted_overlap(
                cand_tokens, tokens[id(leader)], weights)
            if len(shared) < CLUSTER_MIN_SHARED:
                continue
            if len(shared & distinctive) < CLUSTER_MIN_DISTINCTIVE:
                continue
            matched = jaccard >= CLUSTER_MIN_JACCARD or (
                overlap >= CLUSTER_MIN_OVERLAP and len(shared) >= CLUSTER_OVERLAP_MIN_SHARED
            )
            if matched and jaccard > best_score:
                best_leader, best_score = leader, jaccard

        if best_leader is None:
            leaders_by_scope.setdefault(scope_key, []).append(cand)
            members[id(cand)] = 1
        else:
            members[id(best_leader)] += 1
            absorbed.add(id(cand))

    for a in articles:
        a["cluster_size"] = members.get(id(a), 1)

    kept = [i for i in items if id(i) not in absorbed]
    return kept, len(absorbed)


def build_items(run, primary_code, rival_codes, source_ranks=None):
    completed = parse_dt(run.get("completed_at")) or datetime.now(timezone.utc)
    window_hours = run.get("recency_hours_cap") or 24
    cutoff = completed - timedelta(hours=window_hours)
    # Articles get a wider window so Matt can catch up on ones he didn't read the same day.
    # Tweets, transactions, and injuries stay on the base (24h) window to match the digest.
    article_window_hours = int(os.environ.get("NFL_DAILY_ARTICLE_WINDOW_HOURS", ARTICLE_WINDOW_HOURS))
    article_cutoff = completed - timedelta(hours=article_window_hours)
    tracked = {primary_code} | set(rival_codes)
    ranks = source_ranks or {}

    items, seen = [], set()

    def add(item, dedupe_key):
        if dedupe_key in seen:
            return
        seen.add(dedupe_key)
        items.append(item)

    # Tweets (already grouped by scope by the orchestrator)
    tweet_feeds = run.get("tweet_feeds") or {}
    scope_map = {"national": ["national"], "ravens": [primary_code]}
    grouped = [(scope_map.get(k), v) for k, v in tweet_feeds.items() if k != "rivals"]
    for _code, feed in (tweet_feeds.get("rivals") or {}).items():
        grouped.append(([RIVALS_SCOPE], feed))
    for scopes, feed in grouped:
        if not scopes:
            continue
        for t in feed or []:
            dt = parse_dt(t.get("published_at"))
            if dt is None or dt < cutoff:
                continue
            add({
                "id": item_id("tweet", t.get("tweet_id") or t.get("url")),
                "type": "tweet",
                "scopes": scopes,
                "source_id": t.get("source_id"),
                "source_name": t.get("author_name"),
                "title": None,
                "text": clean_text(t.get("text")),
                "url": t.get("url"),
                "published_at": dt.isoformat(),
                "author_handle": t.get("author_handle"),
                "author_name": t.get("author_name"),
                "author_avatar": t.get("author_avatar"),
                "team": None,
                "media": t.get("media") or [],
                "quoted": t.get("quoted"),
                "is_retweet": bool(t.get("is_retweet")),
                "is_self_thread": bool(t.get("is_self_thread")),
                "rt_author": t.get("rt_author"),
            }, ("tweet", t.get("tweet_id") or t.get("url")))

    # Articles + structured rows
    for r in run.get("raw_items") or []:
        sid = r.get("source_id") or ""
        dt = parse_dt(r.get("published_at"))
        if dt is None:
            continue
        if sid.startswith("twitter_") or "_twitter_" in sid:
            continue  # tweet sources ride in via tweet_feeds
        rtype = STRUCTURED_TYPE_BY_SOURCE.get(sid)
        # Articles use the wider window; transactions/injuries stay on the base window.
        if dt < (cutoff if rtype else article_cutoff):
            continue
        if rtype:  # transaction / injury
            team_code = resolve_team(r)
            scopes = ["national"]
            if team_code == primary_code:
                scopes.append(primary_code)
            elif team_code in rival_codes:
                scopes.append(RIVALS_SCOPE)
            add({
                "id": item_id(rtype, sid, r.get("title"), r.get("published_at")),
                "type": rtype,
                "scopes": scopes,
                "source_id": sid,
                "source_name": None,  # filled from sources.yaml below
                "title": clean_text(r.get("title")),
                "text": clean_text(r.get("snippet")),
                "url": r.get("url"),
                "published_at": dt.isoformat(),
                "author_handle": None,
                "author_name": None,
                "team": team_code,
                "media": [],
            }, (rtype, sid, r.get("title")))
        else:  # article
            image = r.get("image")
            add({
                "id": item_id("article", r.get("url")),
                "type": "article",
                "scopes": article_scopes(sid, set(rival_codes)),
                "source_id": sid,
                "source_name": None,
                "title": clean_text(r.get("title")),
                "text": clean_text(r.get("snippet")),
                "url": r.get("url"),
                "published_at": dt.isoformat(),
                "author_handle": None,
                "author_name": clean_text(r.get("author")),
                "team": None,
                # The fetchers extract one image per article; the app reads media[0].url.
                "media": [{"type": "photo", "url": image}] if image else [],
                "source_rank": ranks.get(sid, DEFAULT_SOURCE_RANK),
            }, ("article", r.get("url")))

    items, merged = cluster_articles(items)
    article_count = sum(1 for i in items if i["type"] == "article")
    print(f"article clustering: {article_count + merged} articles → {article_count} items "
          f"({merged} merged into a higher-ranked source)")

    items.sort(key=lambda i: i["published_at"], reverse=True)
    return items, window_hours, article_window_hours


def build_digest(run, primary, rivals):
    outputs = run.get("digest_outputs") or {}
    tabs = []
    if outputs.get("national", {}).get("full_markdown"):
        tabs.append({"scope": "national", "label": "NFL",
                     "markdown": outputs["national"]["full_markdown"]})
    if outputs.get("ravens", {}).get("full_markdown"):
        tabs.append({"scope": primary.get("team_code", "BAL"),
                     "label": primary.get("display_name", "Ravens"),
                     "markdown": outputs["ravens"]["full_markdown"]})
    # One combined Rivals brief, with sections shared across every team rather than a section
    # per team: it is read to catch up on all of them at once, so importance orders it better
    # than team does.
    rival_outputs = outputs.get("rivals") or {}
    markdown = rival_outputs.get("full_markdown")
    if not markdown:
        # A digest written before the prompt was combined arrives keyed by team code. Fold it
        # rather than dropping it, so a stale digest still renders.
        names = {r.get("team_code"): r.get("display_name") for r in rivals}
        parts = [retitle_sections(out["full_markdown"], names.get(code, code))
                 for code, out in rival_outputs.items()
                 if isinstance(out, dict) and out.get("full_markdown")]
        markdown = "\n\n".join(parts)
    if markdown:
        tabs.append({"scope": RIVALS_SCOPE, "label": "Rivals", "markdown": markdown})
    return tabs


def retitle_sections(markdown, team):
    """Fold a per-team digest into the shared Rivals tab by naming its team in every heading.

    The app's brief renderer understands exactly one heading level. Nesting each team's
    existing `## Summary` under a `## Steelers` would need a second level it does not parse,
    and the heading would render as literal text — so the team name joins the section title
    instead of sitting above it."""
    out = []
    for line in markdown.split("\n"):
        if line.startswith("# "):
            continue
        m = re.match(r"^##\s+(.*)$", line)
        out.append(f"## {team} · {m.group(1).strip()}" if m else line)
    return "\n".join(out).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", help="path to a run log JSON (default: newest)")
    ap.add_argument("--sources", default=DEFAULT_SOURCES)
    ap.add_argument("--out", default=os.path.join(REPO_ROOT, "web", "data"))
    ap.add_argument("--force", action="store_true",
                    help="publish even if the safety guard would block (empty/degraded run)")
    args = ap.parse_args()

    run_path = args.run
    if not run_path:
        candidates = sorted(glob.glob(os.path.join(DEFAULT_RUNS_DIR, "*.json")))
        if not candidates:
            sys.exit(f"no run logs found in {DEFAULT_RUNS_DIR}")
        run_path = candidates[-1]

    with open(run_path) as f:
        run = json.load(f)
    primary, rivals, source_names, source_ranks = load_sources_config(args.sources)
    primary_code = primary.get("team_code", "BAL")
    rival_codes = [r.get("team_code") for r in rivals if r.get("team_code")]

    items, window_hours, article_window_hours = build_items(
        run, primary_code, rival_codes, source_ranks)
    for it in items:
        if not it["source_name"]:
            it["source_name"] = source_names.get(it["source_id"], it["source_id"])

    generated_at = run.get("completed_at") or datetime.now(timezone.utc).isoformat()
    health = run.get("source_health") or {}
    if isinstance(health, dict):
        health_list = [{"id": k, **(v or {})} for k, v in health.items()]
    else:
        health_list = health

    # Safety guard: never let a broken run blank the live app. A run is "degraded" if it
    # produced zero items, or if more than half of all sources errored (a mass-fetch failure,
    # e.g. a network-allowlist regression). In that case refuse to overwrite — the last good
    # web/data/*.json stays live — and exit non-zero so the caller skips the commit/push.
    # A genuinely quiet news day is NOT degraded (sources healthy, just few items), so the
    # guard keys on source errors, not item count alone. Override with --force.
    ok, reason = publish_ok(items, health_list)
    if not ok and not args.force:
        print(f"REFUSING TO PUBLISH: {reason}", file=sys.stderr)
        print("Kept the last good web/data/*.json. Re-run with --force to override.", file=sys.stderr)
        return 2

    # Structured data (transactions + injuries) can fail on its own while news sources stay
    # healthy — ESPN's API is behind Akamai and denies some callers. That isn't degraded enough
    # to block the publish (264 news items still beat a stale app), but it does silently blank
    # the Transactions and Injuries sections, which reads as "the run failed". Say so loudly so
    # the run reports it instead of shipping quiet holes.
    structured_count = sum(1 for i in items if i["type"] in ("transaction", "injury"))
    if structured_count == 0:
        bad = [h for h in health_list
               if h.get("id", "").startswith("espn_") and h.get("status") != "ok"]
        print("WARNING: 0 transactions and 0 injuries — Transactions/Injuries sections will be "
              "blank in every tab.", file=sys.stderr)
        for h in bad:
            print(f"  {h.get('id')}: {h.get('status')} — {h.get('note')}", file=sys.stderr)

    os.makedirs(args.out, exist_ok=True)

    def write(name, payload):
        path = os.path.join(args.out, name)
        with open(path, "w") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        print(f"wrote {path} ({os.path.getsize(path)//1024} KB)")

    write("config.json", {
        "schema_version": SCHEMA_VERSION,
        "app_name": "NFL Daily",
        "default_scope": primary_code,
        # Where the app reads live tweets. Empty means "no live source" and the app falls back
        # to the tweets baked into feed.json by the last pipeline run.
        "tweets_url": (os.environ.get("NFL_DAILY_WORKER_URL") or "").rstrip("/"),
        "scopes": (
            [{"code": primary_code, "label": primary.get("display_name", primary_code),
              "short": (primary.get("display_name") or primary_code).split()[-1], "role": "primary"}]
            + [{"code": "national", "label": "NFL", "short": "NFL", "role": "national"}]
            + ([{"code": RIVALS_SCOPE, "label": "Rivals", "short": "Rivals", "role": "rival"}]
               if rivals else [])
        ),
    })
    write("feed.json", {
        "schema_version": SCHEMA_VERSION,
        "run_id": run.get("run_id"),
        "generated_at": generated_at,
        "window_hours": window_hours,
        "article_window_hours": article_window_hours,
        "counts": {t: sum(1 for i in items if i["type"] == t)
                   for t in ("tweet", "article", "transaction", "injury")},
        "items": items,
        "source_health": health_list,
    })
    # The digest is written only by the once-daily synthesis run. Frequent fetch-only runs
    # (articles + tweets) carry no digest_outputs, and rewriting digest.json from one would
    # blank the Home tab until the next synthesis. Leave the last good digest in place.
    tabs = build_digest(run, primary, rivals)
    digest_path = os.path.join(args.out, "digest.json")
    if tabs:
        write("digest.json", {
            "schema_version": SCHEMA_VERSION,
            "run_id": run.get("run_id"),
            "generated_at": generated_at,
            "window_hours": window_hours,
            "tabs": tabs,
        })
    elif os.path.exists(digest_path):
        with open(digest_path) as f:
            kept = json.load(f)
        print(f"kept existing digest.json (run has no digest_outputs) — "
              f"generated {kept.get('generated_at')}")
    else:
        print("WARNING: no digest_outputs in this run and no existing digest.json — "
              "the Home tab will be empty until a synthesis run completes.", file=sys.stderr)
    print(f"run log: {run_path}")
    print(f"items in window: {len(items)}")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
