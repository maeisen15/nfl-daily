#!/usr/bin/env python3
"""Tweet sweeps.

Tweets no longer ride through the orchestrator's per-source fan-out. They reach the app three
ways, all landing in the same Cloudflare D1 store keyed by tweet id:

  webhook   twitterapi.io pushes each matched tweet to the Worker seconds after it posts.
            Set up once with `rules.py`; nothing here is involved at runtime.
  search    `--mode search` — Advanced Search over OR-chained `from:` handles with a
            `since_time` watermark. Billed per tweet *returned*, so checking often is nearly
            free. Reconciles anything the webhook dropped and backfills the rich fields
            (media, quoted posts) a thin webhook payload may omit.
  backstop  `--mode backstop` — the old per-handle `last_tweets` endpoint, paginated. Billed
            a full 20-tweet page per handle, so this runs once a day. It is the safety net for
            the one thing search can't guarantee: Twitter's search index occasionally lags or
            drops a post.

Raw tweet objects are POSTed to the Worker as-is; normalization lives there so the webhook and
these sweeps can't drift apart.

Usage:
    python3 pipeline/tweets.py --mode search              # reconcile since the watermark
    python3 pipeline/tweets.py --mode backstop            # full per-handle sweep
    python3 pipeline/tweets.py --mode search --dry-run    # fetch, report, push nothing
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
MAX_PAGES_BACKSTOP = 5
# Re-ask for a slice we already have. Tweets can surface in the search index out of order, and
# a few duplicate tweets cost $0.00015 each — far cheaper than a hole in the feed.
WATERMARK_OVERLAP_MIN = 20
# Conservative ceiling for one Advanced Search query. Tested comfortably at 217 chars.
MAX_QUERY_CHARS = 450


def main() -> int:
    ap = argparse.ArgumentParser(description="NFL Daily tweet sweeps")
    ap.add_argument("--mode", choices=("search", "backstop"), default="search")
    ap.add_argument("--since-hours", type=float, default=None,
                    help="Override the watermark and look back this many hours.")
    ap.add_argument("--dry-run", action="store_true", help="Fetch and report; push nothing.")
    ap.add_argument("--dump", help="Also write the raw tweets to this JSON path.")
    args = ap.parse_args()

    api_key = load_secret("TWITTERAPI_IO_KEY")
    if not api_key:
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

    started = time.monotonic()
    if args.mode == "search":
        since = resolve_since(worker_url, args.since_hours)
        print(f"search watermark: {since.isoformat()} "
              f"({(datetime.now(timezone.utc) - since).total_seconds() / 3600:.1f}h back)",
              file=sys.stderr)
        tweets = sweep_search(api_key, handles, since)
    else:
        tweets = sweep_backstop(api_key, handles)

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


def sweep_backstop(api_key: str, handles: list[dict[str, Any]]) -> list[dict]:
    """Per-handle `last_tweets`, paginated back through the retention window. Expensive by
    design (a full page is billed whether or not it's new) — this is the completeness check,
    not the freshness path."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=48)
    out: list[dict] = []
    for h in handles:
        page, cursor, got = 0, "", 0
        while page < MAX_PAGES_BACKSTOP:
            params = {"userName": h["handle"], "includeReplies": "true"}
            if cursor:
                params["cursor"] = cursor
            try:
                body = api_get(api_key, "/twitter/user/last_tweets", params)
            except Exception as exc:  # noqa: BLE001
                print(f"  {h['handle']}: ERROR {exc}", file=sys.stderr)
                break
            payload = body.get("data") or body
            tweets = payload.get("tweets") or []
            out.extend(tweets)
            got += len(tweets)
            page += 1
            cursor = payload.get("next_cursor") or body.get("next_cursor") or ""
            oldest = min((parse_twitter_date(t.get("createdAt")) for t in tweets
                          if t.get("createdAt")), default=None)
            has_next = payload.get("has_next_page", body.get("has_next_page"))
            # Stop as soon as the page reaches past the retention window.
            if not tweets or not has_next or not cursor or (oldest and oldest < cutoff):
                break
        print(f"  {h['handle']}: {got} tweets over {page} page(s)", file=sys.stderr)
    return out


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
