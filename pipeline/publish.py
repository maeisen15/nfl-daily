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
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

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

    def walk(node):
        if isinstance(node, dict):
            if "id" in node and "name" in node:
                names[node["id"]] = node["name"]
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(cfg)
    return primary, rivals, names


def article_scopes(source_id, tracked_rival_codes):
    if source_id.startswith("ravens_"):
        return ["BAL"]
    m = re.match(r"rival_([a-z]{2,3})_", source_id)
    if m:
        code = m.group(1).upper()
        return [code] if code in tracked_rival_codes else ["national"]
    return ["national"]


def build_items(run, primary_code, rival_codes):
    completed = parse_dt(run.get("completed_at")) or datetime.now(timezone.utc)
    window_hours = run.get("recency_hours_cap") or 24
    cutoff = completed - timedelta(hours=window_hours)
    # Articles get a wider window so Matt can catch up on ones he didn't read the same day.
    # Tweets, transactions, and injuries stay on the base (24h) window to match the digest.
    article_window_hours = int(os.environ.get("NFL_DAILY_ARTICLE_WINDOW_HOURS", ARTICLE_WINDOW_HOURS))
    article_cutoff = completed - timedelta(hours=article_window_hours)
    tracked = {primary_code} | set(rival_codes)

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
    for code, feed in (tweet_feeds.get("rivals") or {}).items():
        grouped.append(([code], feed))
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
                "text": t.get("text"),
                "url": t.get("url"),
                "published_at": dt.isoformat(),
                "author_handle": t.get("author_handle"),
                "author_name": t.get("author_name"),
                "team": None,
                "media": t.get("media") or [],
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
            if team_code in tracked:
                scopes.append(team_code)
            add({
                "id": item_id(rtype, sid, r.get("title"), r.get("published_at")),
                "type": rtype,
                "scopes": scopes,
                "source_id": sid,
                "source_name": None,  # filled from sources.yaml below
                "title": r.get("title"),
                "text": r.get("snippet"),
                "url": r.get("url"),
                "published_at": dt.isoformat(),
                "author_handle": None,
                "author_name": None,
                "team": team_code,
                "media": [],
            }, (rtype, sid, r.get("title")))
        else:  # article
            add({
                "id": item_id("article", r.get("url")),
                "type": "article",
                "scopes": article_scopes(sid, set(rival_codes)),
                "source_id": sid,
                "source_name": None,
                "title": r.get("title"),
                "text": r.get("snippet"),
                "url": r.get("url"),
                "published_at": dt.isoformat(),
                "author_handle": None,
                "author_name": r.get("author"),
                "team": None,
                "media": [],
            }, ("article", r.get("url")))

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
    rival_names = {r.get("team_code"): r.get("display_name") for r in rivals}
    for code, out in (outputs.get("rivals") or {}).items():
        if out.get("full_markdown"):
            tabs.append({"scope": code, "label": rival_names.get(code, code),
                         "markdown": out["full_markdown"]})
    return tabs


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
    primary, rivals, source_names = load_sources_config(args.sources)
    primary_code = primary.get("team_code", "BAL")
    rival_codes = [r.get("team_code") for r in rivals if r.get("team_code")]

    items, window_hours, article_window_hours = build_items(run, primary_code, rival_codes)
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
        "scopes": (
            [{"code": primary_code, "label": primary.get("display_name", primary_code),
              "short": (primary.get("display_name") or primary_code).split()[-1], "role": "primary"}]
            + [{"code": "national", "label": "NFL", "short": "NFL", "role": "national"}]
            + [{"code": r["team_code"], "label": r.get("display_name", r["team_code"]),
                "short": (r.get("display_name") or r["team_code"]).split()[-1], "role": "rival"}
               for r in rivals]
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
    write("digest.json", {
        "schema_version": SCHEMA_VERSION,
        "run_id": run.get("run_id"),
        "generated_at": generated_at,
        "window_hours": window_hours,
        "tabs": build_digest(run, primary, rivals),
    })
    print(f"run log: {run_path}")
    print(f"items in window: {len(items)}")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
