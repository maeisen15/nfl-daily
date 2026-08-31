#!/usr/bin/env python3
"""Handle sync and manual tweet backfill.

Routine tweet ingest is not here — the Cloudflare Worker polls for tweets itself on a
waking-hours cadence (see worker/src/index.js). This script covers the two things that happen
outside that loop:

  sync-handles  Push the handle -> scope map from sources.yaml into the Worker's D1. The
                poller builds its query from that table, so this is the step that actually
                puts a new handle on the air. Costs nothing; touches no tweet API.
  search        Manual Advanced Search backfill over a window you choose. Useful right after
                adding a handle, to pull their recent tweets in rather than waiting for them
                to post again.

A note on cost, because a wrong assumption here is what made this app expensive once already.
Measured directly against the billing endpoint (100,000 credits = $1.00):

    a search returning 0 tweets    ~26 credits, flat, per request
    a search returning 20 tweets    300 credits, i.e. 15 credits per tweet returned

So a backfill's price is set by how many tweets are in the window, not by how wide the window
is. `--since-hours 48` over a quiet stretch is cheap; the same flag mid-season is not.

Usage:
    python3 pipeline/tweets.py --mode sync-handles          # after editing sources.yaml
    python3 pipeline/tweets.py --mode search --since-hours 6
    python3 pipeline/tweets.py --mode search --dry-run      # fetch, report, push nothing
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCES_FILE = Path(os.environ.get("NFL_DAILY_SOURCES", REPO_ROOT / "config" / "sources.yaml"))
SECRETS_FILE = Path(os.path.expanduser(os.environ.get("NFL_DAILY_SECRETS", "~/.nfl-digest/secrets.env")))

API_BASE = "https://api.twitterapi.io"
TIMEOUT = 30
# Advanced Search pages at 20. The daily reconciliation covers 26 hours, and a busy in-season
# day across 17 handles runs past 300 tweets — the cap has to clear that or the sweep silently
# stops short of the window it claims to cover. It only bounds a runaway backfill; normal cost
# is set by how many tweets actually exist, not by this number.
MAX_PAGES_SEARCH = 40
# Re-ask for a slice we already have. Tweets can surface in the search index out of order, and
# a few duplicate tweets cost $0.00015 each — far cheaper than a hole in the feed.
WATERMARK_OVERLAP_MIN = 20
# Ceiling for one Advanced Search query. Measured: a 506-char query returns tweets, a 528-char
# one returns zero — with no error and no message, indistinguishable from a quiet news day. The
# real cliff is almost certainly 512. Split well short of it; a silent empty feed is the worst
# failure this system has.
MAX_QUERY_CHARS = 500


def main() -> int:
    ap = argparse.ArgumentParser(description="NFL Daily handle sync and manual backfill")
    ap.add_argument("--mode", choices=("sync-handles", "search"), default="sync-handles")
    ap.add_argument("--since-hours", type=float, default=None,
                    help="Backfill window for --mode search. Defaults to the store watermark.")
    ap.add_argument("--dry-run", action="store_true", help="Fetch and report; push nothing.")
    ap.add_argument("--dump", help="Also write the raw tweets to this JSON path.")
    args = ap.parse_args()

    api_key = load_secret("TWITTERAPI_IO_KEY")
    if not api_key and args.mode != "sync-handles":
        print("ERROR: TWITTERAPI_IO_KEY not set (env or ~/.nfl-digest/secrets.env)", file=sys.stderr)
        return 1
    worker_url = (os.environ.get("NFL_DAILY_WORKER_URL") or "").rstrip("/")
    push_secret = load_secret("NFL_DAILY_PUSH_SECRET")
    if not args.dry_run and not (worker_url and push_secret):
        print("ERROR: NFL_DAILY_WORKER_URL and NFL_DAILY_PUSH_SECRET are required to push.",
              file=sys.stderr)
        print("       (Use --dry-run to fetch without pushing.)", file=sys.stderr)
        return 1

    handles = load_handles()
    if not handles:
        print("ERROR: no enabled twitter handles in sources.yaml", file=sys.stderr)
        return 1
    print(f"{len(handles)} handles across scopes: "
          f"{sorted({h['scope'] for h in handles})}", file=sys.stderr)

    # Handle sync is the common case and costs nothing, so it gets its own short path: push
    # the routing table and stop, without touching the tweet API at all.
    if args.mode == "sync-handles":
        if args.dry_run:
            for h in handles:
                print(f"  {h['scope']:>8}  {h['handle']}", file=sys.stderr)
            return 0
        result = push(worker_url, push_secret, [], handles, "sync-handles")
        print(f"synced {len(handles)} handles: {json.dumps(result)}", file=sys.stderr)
        _warn_if_query_splits(handles)
        return 0

    started = time.monotonic()
    since = resolve_since(worker_url, args.since_hours)
    print(f"search watermark: {since.isoformat()} "
          f"({(datetime.now(timezone.utc) - since).total_seconds() / 3600:.1f}h back)",
          file=sys.stderr)
    tweets = sweep_search(api_key, handles, since)

    unique = dedupe(tweets)
    elapsed = time.monotonic() - started
    print(f"{args.mode}: {len(unique)} unique tweets in {elapsed:.1f}s "
          f"(~${len(unique) * 0.00015:.4f})", file=sys.stderr)

    if args.dump:
        Path(args.dump).write_text(json.dumps(unique, indent=2))
        print(f"wrote {args.dump}", file=sys.stderr)

    if args.dry_run:
        summarize(unique)
        return 0

    result = push(worker_url, push_secret, unique, handles, args.mode)
    print(f"pushed: {json.dumps(result)}", file=sys.stderr)
    summarize(unique)
    return 0


# ---------- config ----------

def load_handles() -> list[dict[str, Any]]:
    """Flatten every enabled twitter handle in sources.yaml into {handle, display_name, scope,
    feed_only}. `scope` matches the app's scope codes so the Worker can route without knowing
    anything about the YAML's structure."""
    with SOURCES_FILE.open() as f:
        cfg = yaml.safe_load(f)

    out: list[dict[str, Any]] = []

    def add(tw: dict[str, Any], scope: str) -> None:
        if not tw.get("enabled", True):
            return
        out.append({
            "handle": tw["handle"],
            "display_name": tw.get("name") or tw["handle"],
            "scope": scope,
            "feed_only": bool(tw.get("feed_only", False)),
        })

    for tier in ("twitter_news_handles", "twitter_analysis_handles"):
        for tw in cfg.get(tier) or []:
            add(tw, "national")

    tc = cfg.get("team_coverage") or {}
    primary = tc.get("primary") or {}
    primary_code = primary.get("team_code", "BAL")
    for tw in primary.get("twitter_handles") or []:
        add(tw, primary_code)
    for rival in tc.get("rivals") or []:
        code = rival.get("team_code") or ""
        for tw in rival.get("twitter_handles") or []:
            add(tw, code)

    return out


def build_queries(handles: list[dict[str, Any]], since: datetime) -> list[str]:
    """Pack handles into as few Advanced Search queries as the length budget allows.

    Grouping is purely by length, not by scope — the Worker routes on the author's handle, so a
    query may freely span tabs. Fewer queries means fewer per-request minimum charges."""
    suffix = f" include:nativeretweets since_time:{int(since.timestamp())}"
    budget = MAX_QUERY_CHARS - len(suffix) - 2  # parens
    queries, group, length = [], [], 0
    for h in handles:
        term = f"from:{h['handle']}"
        add_len = len(term) + (4 if group else 0)  # " OR "
        if group and length + add_len > budget:
            queries.append(f"({' OR '.join(group)}){suffix}")
            group, length = [], 0
            add_len = len(term)
        group.append(term)
        length += add_len
    if group:
        queries.append(f"({' OR '.join(group)}){suffix}")
    return queries


# ---------- sweeps ----------

def resolve_since(worker_url: str, since_hours: float | None) -> datetime:
    """Watermark for the search sweep: the newest tweet the store already holds, minus an
    overlap. Keeping the watermark server-side means a runner with no local state (GitHub
    Actions, the cloud agent) resumes exactly where the last sweep stopped."""
    now = datetime.now(timezone.utc)
    if since_hours is not None:
        return now - timedelta(hours=since_hours)
    if worker_url:
        try:
            health = http_json("GET", f"{worker_url}/health", timeout=15)
            newest = health.get("newest_tweet_at")
            if newest:
                dt = datetime.fromisoformat(newest.replace("Z", "+00:00"))
                # Don't let a stale store trigger an unbounded backfill.
                floor = now - timedelta(hours=48)
                return max(dt - timedelta(minutes=WATERMARK_OVERLAP_MIN), floor)
        except Exception as exc:  # noqa: BLE001
            print(f"warn: couldn't read watermark from Worker ({exc}); defaulting to 2h",
                  file=sys.stderr)
    return now - timedelta(hours=2)


def sweep_search(api_key: str, handles: list[dict[str, Any]], since: datetime) -> list[dict]:
    out: list[dict] = []
    for i, query in enumerate(build_queries(handles, since), 1):
        page, cursor, got = 0, "", 0
        while page < MAX_PAGES_SEARCH:
            params = {"query": query, "queryType": "Latest"}
            if cursor:
                params["cursor"] = cursor
            body = api_get(api_key, "/twitter/tweet/advanced_search", params)
            tweets = body.get("tweets") or []
            out.extend(tweets)
            got += len(tweets)
            page += 1
            cursor = body.get("next_cursor") or ""
            if not body.get("has_next_page") or not cursor or not tweets:
                break
        if page >= MAX_PAGES_SEARCH:
            print(f"warn: query {i} hit the {MAX_PAGES_SEARCH}-page cap — "
                  f"older tweets in this window were not fetched", file=sys.stderr)
        print(f"  query {i}: {got} tweets over {page} page(s)", file=sys.stderr)
    return out


def _warn_if_query_splits(handles: list[dict[str, Any]]) -> None:
    """One request covers every handle for the same ~26-credit floor, so the poll gets more
    expensive in a step, not a slope: it costs the same until the handle list no longer fits in
    one query, then doubles. Worth saying out loud at the moment someone crosses that line."""
    n = len(build_queries(handles, datetime.now(timezone.utc)))
    if n > 1:
        print(f"note: {len(handles)} handles no longer fit one query — the Worker will send {n} "
              f"requests per poll instead of 1 (about +${(n - 1) * 1.09:.2f}/month).",
              file=sys.stderr)


def dedupe(tweets: list[dict]) -> list[dict]:
    seen, out = set(), []
    for t in tweets:
        tid = str(t.get("id") or "")
        if not tid or tid in seen:
            continue
        seen.add(tid)
        out.append(t)
    return out


def summarize(tweets: list[dict]) -> None:
    from collections import Counter
    by_author = Counter()
    retweets = 0
    for t in tweets:
        by_author[(t.get("author") or {}).get("userName") or "?"] += 1
        if t.get("retweeted_tweet"):
            retweets += 1
    if not tweets:
        print("no new tweets", file=sys.stderr)
        return
    print(f"  {retweets} retweets; top authors: "
          f"{', '.join(f'{a}={n}' for a, n in by_author.most_common(6))}", file=sys.stderr)


# ---------- http ----------

def api_get(api_key: str, path: str, params: dict[str, Any]) -> dict:
    last_exc: Exception | None = None
    for backoff in (0, 3, 8, 15):
        if backoff:
            time.sleep(backoff)
        try:
            resp = requests.get(
                f"{API_BASE}{path}",
                params=params,
                headers={"X-API-Key": api_key, "Accept": "application/json",
                         "User-Agent": "nfl-daily/1.0"},
                timeout=TIMEOUT,
            )
            # 429 and 5xx are worth another try; a 4xx is a bad request and won't improve.
            if resp.status_code == 429 or resp.status_code >= 500:
                last_exc = RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as exc:
            last_exc = exc
    raise RuntimeError(f"request failed after retries: {last_exc}")


def push(worker_url: str, secret: str, tweets: list[dict], handles: list[dict], mode: str) -> dict:
    """POST tweets to the Worker in batches, syncing the handle->scope map on the first one."""
    BATCH = 100
    totals = {"received": 0, "written": 0, "handles_synced": 0}
    batches = [tweets[i:i + BATCH] for i in range(0, len(tweets), BATCH)] or [[]]
    for i, batch in enumerate(batches):
        payload = {"tweets": batch, "source": mode}
        if i == 0:
            payload["handles"] = handles
        res = http_json("POST", f"{worker_url}/push", payload,
                        headers={"Authorization": f"Bearer {secret}"})
        for k in totals:
            totals[k] += res.get(k, 0) or 0
    return totals


def http_json(method: str, url: str, payload: Any = None, headers: dict | None = None,
              timeout: int = TIMEOUT) -> dict:
    resp = requests.request(
        method, url, json=payload, timeout=timeout,
        headers={"User-Agent": "nfl-daily/1.0", **(headers or {})},
    )
    resp.raise_for_status()
    return resp.json()


def parse_twitter_date(value: Any) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    from email.utils import parsedate_to_datetime
    try:
        dt = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def load_secret(key: str) -> str | None:
    if os.environ.get(key):
        return os.environ[key]
    if not SECRETS_FILE.exists():
        return None
    for line in SECRETS_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == key:
            return v.strip().strip("\"'")
    return None


if __name__ == "__main__":
    raise SystemExit(main())
