#!/usr/bin/env python3
"""NFL Daily Digest orchestrator.

Fetches the *free* sources: articles, structured data, podcasts. Tweets are NOT fetched here —
they arrive continuously via the twitterapi.io webhook into the Cloudflare Worker (see
pipeline/tweets.py and worker/). This orchestrator reads them back out of the Worker, which
costs nothing and returns the already-deduplicated, retention-pruned set.

Reads config/sources.yaml, fans out to fetchers in parallel, writes a timestamped run log to
runtime/runs/<ISO8601>.json, and prints a JSON "synthesis package" to stdout that the
synthesizing Claude consumes to produce the slim digest (see prompts/digest.md). Paths are
repo-local by default; NFL_DAILY_RUNTIME / NFL_DAILY_SOURCES / NFL_DAILY_PROMPTS override them.

Usage:
    python3 orchestrator.py                    # full run; writes run log + prints package
    python3 orchestrator.py --days N           # recency window in days back (1-7, default 1)
    python3 orchestrator.py --include-undated  # keep items with no parseable date
    python3 orchestrator.py --source-id ID     # fetch a single source (debug)
    python3 orchestrator.py --dry-run          # smoke test; no run log written
    python3 orchestrator.py --summary-only     # print counts instead of the full package
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
import yaml

# Add the skill dir to sys.path so we can import fetchers package
SKILL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SKILL_DIR))

from fetchers import rss as rss_fetcher  # noqa: E402
from fetchers import api as api_fetcher  # noqa: E402
from fetchers import html as html_fetcher  # noqa: E402
from fetchers import espn_api as espn_api_fetcher  # noqa: E402

# Repo-local by default; NFL_DAILY_RUNTIME overrides (e.g. ~/.nfl-digest for the legacy setup).
REPO_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIR = Path(os.environ.get("NFL_DAILY_RUNTIME", REPO_ROOT / "runtime")).expanduser()
SOURCES_FILE = Path(os.environ.get("NFL_DAILY_SOURCES", REPO_ROOT / "config" / "sources.yaml")).expanduser()
RUNS_DIR = RUNTIME_DIR / "runs"
PROMPTS_DIR = Path(os.environ.get("NFL_DAILY_PROMPTS", REPO_ROOT / "prompts")).expanduser()

# Snippet pre-truncation when emitting the synthesis package (full snippet stays in run log).
SNIPPET_MAX_CHARS = 220
TITLE_MAX_CHARS = 240
# Podcasts publish weekly (not daily), so they get a separate, fixed 7-day window regardless
# of the --days N flag. Without this, a 1-day window would virtually always have 0 podcasts.
PODCAST_RECENCY_HOURS = 24 * 7

FETCHERS = {
    "rss": rss_fetcher.fetch,
    "api": api_fetcher.fetch,
    "html": html_fetcher.fetch,
    "espn_api": espn_api_fetcher.fetch,
}

STRUCTURED_SOURCE_IDS = {
    "espn_injuries",
    "espn_transactions",
    "nfl_com_injuries",
    "nfl_com_transactions",
}


def main() -> int:
    parser = argparse.ArgumentParser(description="NFL Daily Digest orchestrator")
    parser.add_argument("--dry-run", action="store_true", help="Skip writing the run log")
    parser.add_argument(
        "--days",
        type=int,
        default=1,
        choices=range(1, 8),
        metavar="N",
        help="Recency window in days back from now (1-7). Default 1 (= past 24h).",
    )
    parser.add_argument(
        "--include-undated",
        action="store_true",
        help="Keep items with no published_at. Default is to drop them (strict recency).",
    )
    parser.add_argument(
        "--source-id",
        action="append",
        default=None,
        help="Restrict to one or more source IDs (repeatable). Useful for debugging.",
    )
    parser.add_argument(
        "--summary-only",
        action="store_true",
        help="Print a short summary instead of the full synthesis package (debug aid).",
    )
    args = parser.parse_args()

    if not SOURCES_FILE.exists():
        print(f"ERROR: sources file not found: {SOURCES_FILE}", file=sys.stderr)
        print("Expected config/sources.yaml in the repo (or set NFL_DAILY_SOURCES).", file=sys.stderr)
        return 1

    with SOURCES_FILE.open() as f:
        config = yaml.safe_load(f)

    sources = _collect_sources(config, restrict=args.source_id)
    if not sources:
        print("ERROR: no enabled sources matched the filter", file=sys.stderr)
        return 1

    # CLI --days takes precedence over sources.yaml recency_hours_cap.
    recency_cap_hours = args.days * 24

    started_at = datetime.now(timezone.utc)
    run_id = started_at.strftime("%Y-%m-%dT%H%M%S")

    fetch_results: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(8, len(sources))) as pool:
        future_to_source = {pool.submit(_dispatch, src): src for src in sources}
        for future in as_completed(future_to_source):
            src = future_to_source[future]
            try:
                fetch_results.append(future.result())
            except Exception as exc:  # noqa: BLE001
                fetch_results.append(
                    {
                        "source_id": src["id"],
                        "status": "error",
                        "items_fetched": 0,
                        "latency_ms": 0,
                        "note": f"dispatch crash: {type(exc).__name__}: {exc}",
                        "items": [],
                    }
                )

    completed_at = datetime.now(timezone.utc)

    source_health = {
        r["source_id"]: {
            "status": r["status"],
            "items_fetched": r["items_fetched"],
            "latency_ms": r["latency_ms"],
            "note": r["note"],
        }
        for r in fetch_results
    }
    raw_items = [item for r in fetch_results for item in r["items"]]

    podcast_raw = [it for it in raw_items if it["source_id"].startswith("podcast_")]
    non_podcast_raw = [it for it in raw_items if not it["source_id"].startswith("podcast_")]
    news_filtered = _apply_recency_filter(
        non_podcast_raw, completed_at, recency_cap_hours, strict=not args.include_undated
    )
    podcast_filtered = _apply_recency_filter(
        podcast_raw, completed_at, PODCAST_RECENCY_HOURS, strict=not args.include_undated
    )
    # Tweets live in the Worker, fed continuously by the twitterapi.io webhook. Reading them
    # back costs nothing and yields the deduplicated, retention-pruned set.
    tweet_feeds, tweet_synthesis_items, tweet_error = _load_tweets_from_worker(recency_cap_hours)
    if tweet_error:
        print(f"WARNING: tweets unavailable — {tweet_error}", file=sys.stderr)
    source_health["twitter_worker"] = {
        "status": "error" if tweet_error else "ok",
        "items_fetched": sum(len(v) for k, v in tweet_feeds.items() if k != "rivals")
                         + sum(len(v) for v in tweet_feeds["rivals"].values()),
        "latency_ms": 0,
        "note": tweet_error,
    }

    run_log = {
        "run_id": run_id,
        "started_at": started_at.isoformat(),
        "completed_at": completed_at.isoformat(),
        "source_health": source_health,
        "raw_items": raw_items,
        "tweet_feeds": tweet_feeds,
        "digest_outputs": None,  # synthesis Claude writes per-tab markdown here
        "prompt_version": "digest",
        "recency_hours_cap": recency_cap_hours,
    }

    out_path: Path | None = None
    if not args.dry_run:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        out_path = RUNS_DIR / f"{run_id}.json"
        with out_path.open("w") as f:
            json.dump(run_log, f, indent=2, default=str)

    # Build the synthesis package (slim view for the in-session Claude).
    # Podcasts use a fixed 7-day window (their natural cadence); everything else uses
    # the user's chosen --days window. news_filtered + podcast_filtered were already produced
    # above (used to build tweet_feeds before the run log was written).
    recency_filtered = news_filtered + podcast_filtered  # for totals/reporting only

    truncated_news = [_truncate_item(it) for it in news_filtered]
    truncated_podcasts = [_truncate_item(it) for it in podcast_filtered]
    structured_items = [it for it in truncated_news if it["source_id"] in STRUCTURED_SOURCE_IDS]
    # Articles + the quotable subset of tweets. feed_only handles and pure retweets are
    # already excluded by _load_tweets_from_worker.
    news_items = [
        it for it in truncated_news if it["source_id"] not in STRUCTURED_SOURCE_IDS
    ] + tweet_synthesis_items
    podcast_items = truncated_podcasts

    # Pointer for reference only — the synthesizing agent reads the prompt per RUNBOOK.md.
    prompt_path = PROMPTS_DIR / "digest.md"
    synthesis_package = {
        "run_id": run_id,
        "generated_at": completed_at.isoformat(),
        "run_log_path": str(out_path) if out_path else None,
        "prompt_path": str(prompt_path) if prompt_path.exists() else None,
        "days_back": args.days,
        "recency_hours_cap": recency_cap_hours,
        "strict_recency": not args.include_undated,
        "recency_kept": len(recency_filtered),
        "recency_dropped": len(raw_items) - len(recency_filtered),
        "source_health": source_health,
        "team_coverage": _team_coverage_meta(config),
        "structured_data": structured_items,
        "podcast_items": podcast_items,
        "news_items": news_items,  # articles + quotable tweets; minus structured, podcasts, feed_only
        "tweet_feeds": tweet_feeds,  # per-tab raw tweet pool for the Tweet Feed UI (verbatim, not synthesized)
        "totals": {
            "raw_in": len(raw_items),
            "after_recency": len(recency_filtered),
            "structured_count": len(structured_items),
            "podcast_count": len(podcast_items),
            "news_count": len(news_items),
        },
        "sources_summary": {
            "ok": sum(1 for r in fetch_results if r["status"] == "ok"),
            "warn": sum(1 for r in fetch_results if r["status"] == "warn"),
            "error": sum(1 for r in fetch_results if r["status"] == "error"),
        },
    }

    if args.summary_only:
        print(
            json.dumps(
                {
                    "run_id": run_id,
                    "totals": synthesis_package["totals"],
                    "sources_summary": synthesis_package["sources_summary"],
                    "run_log_path": synthesis_package["run_log_path"],
                },
                indent=2,
            )
        )
    else:
        print(json.dumps(synthesis_package, indent=2, default=str))

    return 0


def _collect_sources(config: dict[str, Any], restrict: list[str] | None = None) -> list[dict[str, Any]]:
    """Flatten sources.yaml into a single list of enabled source dicts."""
    out: list[dict[str, Any]] = []
    for tier in ("news_sources", "analysis_sources", "structured_data", "podcasts"):
        for src in config.get(tier) or []:
            if not src.get("enabled", True):
                continue
            if restrict and src.get("id") not in restrict:
                continue
            src = dict(src)
            src["tier"] = tier
            out.append(src)

    # team_coverage: drives the Ravens + Rivals tabs in the digest. Primary's news/twitter
    # sources are emitted with ids like `ravens_news_<slug>` / `ravens_twitter_<handle>` (the
    # ids are pre-set in sources.yaml for news entries). Rivals use `rival_<code>_news_*` /
    # `rival_<code>_twitter_*`. The id prefix is what the synthesis prompt uses to route items
    # into the right tab.
    team_coverage = config.get("team_coverage") or {}
    primary = team_coverage.get("primary") or {}
    for src in primary.get("news_sources") or []:
        if not src.get("enabled", True):
            continue
        if restrict and src.get("id") not in restrict:
            continue
        src = dict(src)
        src["tier"] = "team_primary_news"
        src["team_code"] = primary.get("team_code")
        out.append(src)
    for rival in team_coverage.get("rivals") or []:
        team_code = rival.get("team_code") or ""
        for src in rival.get("news_sources") or []:
            if not src.get("enabled", True):
                continue
            if restrict and src.get("id") not in restrict:
                continue
            src = dict(src)
            src["tier"] = "team_rival_news"
            src["team_code"] = team_code
            out.append(src)
    return out


def _load_tweets_from_worker(hours: int) -> tuple[dict[str, Any], list[dict[str, Any]], str | None]:
    """Read the tweet store back out of the Worker.

    Returns (tweet_feeds, synthesis_items, error). `tweet_feeds` keeps the legacy per-tab shape
    that publish.py already understands. `synthesis_items` is the subset the digest may quote:
    feed_only handles (team accounts, analysts kept for browsing) and pure retweets are
    excluded, matching the pre-Worker behaviour.

    A Worker that is unreachable is a warning, not a failure — articles still publish, and the
    app falls back to whatever tweets the last good feed.json holds.
    """
    feeds: dict[str, Any] = {"national": [], "ravens": [], "rivals": {}}
    worker_url = (os.environ.get("NFL_DAILY_WORKER_URL") or "").rstrip("/")
    if not worker_url:
        return feeds, [], "NFL_DAILY_WORKER_URL not set — no tweets in this run"

    try:
        resp = requests.get(f"{worker_url}/tweets", params={"hours": hours, "limit": 500},
                            timeout=30)
        resp.raise_for_status()
        items = resp.json().get("items") or []
    except Exception as exc:  # noqa: BLE001
        return feeds, [], f"{type(exc).__name__}: {exc}"

    feed_only = {h["handle"].lower() for h in _yaml_handles() if h["feed_only"]}
    primary_code = _primary_code()

    synthesis: list[dict[str, Any]] = []
    for it in items:
        scope = (it.get("scopes") or ["national"])[0]
        entry = {
            "source_id": it.get("source_id"),
            "author_handle": it.get("author_handle") or "",
            "author_name": it.get("author_name") or "",
            "tweet_id": it.get("id") or "",
            "url": it.get("url") or "",
            "text": it.get("text") or "",
            "published_at": it.get("published_at"),
            "media": it.get("media") or [],
            "quoted": it.get("quoted"),
            "is_retweet": bool(it.get("is_retweet")),
            "is_self_thread": bool(it.get("is_self_thread")),
            "rt_author": it.get("rt_author"),
        }
        if scope == primary_code:
            feeds["ravens"].append(entry)
        elif scope == "national":
            feeds["national"].append(entry)
        else:
            feeds["rivals"].setdefault(scope, []).append(entry)

        if entry["author_handle"].lower() in feed_only or entry["is_retweet"]:
            continue
        synthesis.append({
            "source_id": entry["source_id"],
            "title": _clean_trim(entry["text"], TITLE_MAX_CHARS),
            "snippet": None,
            "url": entry["url"],
            "published_at": entry["published_at"],
            "author": entry["author_handle"],
            "scope": scope,
        })

    return feeds, synthesis, None


def _yaml_handles() -> list[dict[str, Any]]:
    """Handle metadata from sources.yaml (shared with pipeline/tweets.py)."""
    from tweets import load_handles
    return load_handles()


def _primary_code() -> str:
    with SOURCES_FILE.open() as f:
        cfg = yaml.safe_load(f)
    return ((cfg.get("team_coverage") or {}).get("primary") or {}).get("team_code", "BAL")


def _team_coverage_meta(config: dict[str, Any]) -> dict[str, Any]:
    """Slim view of team_coverage for the synthesis package — primary + rivals identifiers and
    display names so the synth prompt knows which tabs to produce."""
    tc = config.get("team_coverage") or {}
    primary = tc.get("primary") or {}
    rivals = tc.get("rivals") or []
    return {
        "primary": {
            "team_code": primary.get("team_code"),
            "display_name": primary.get("display_name"),
        } if primary else None,
        "rivals": [
            {
                "team_code": r.get("team_code"),
                "display_name": r.get("display_name"),
            }
            for r in rivals
        ],
    }


def _dispatch(source: dict[str, Any]) -> dict[str, Any]:
    method = source.get("fetch", "").lower()
    fetcher = FETCHERS.get(method)
    if fetcher is None:
        return {
            "source_id": source["id"],
            "status": "error",
            "items_fetched": 0,
            "latency_ms": 0,
            "note": f"no fetcher registered for method '{method}'",
            "items": [],
        }
    return fetcher(source)


def _apply_recency_filter(
    items: list[dict[str, Any]], now: datetime, hours_cap: int, strict: bool = True
) -> list[dict[str, Any]]:
    """Drop items older than `hours_cap` hours.

    `strict` (default True): items without a usable `published_at` are DROPPED. This is the
    safe default — when the user asks for "past 24h" we don't pretend dateless items are
    recent. Pass `strict=False` (via `--include-undated`) to keep them.
    """
    cutoff = now - timedelta(hours=hours_cap)
    kept: list[dict[str, Any]] = []
    for it in items:
        pub = it.get("published_at")
        if not pub:
            if not strict:
                kept.append(it)
            continue
        try:
            dt = datetime.fromisoformat(pub.replace("Z", "+00:00"))
        except (TypeError, ValueError):
            if not strict:
                kept.append(it)
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        if dt >= cutoff:
            kept.append(it)
    return kept


def _truncate_item(item: dict[str, Any]) -> dict[str, Any]:
    out = dict(item)
    out["title"] = _clean_trim(out.get("title") or "", TITLE_MAX_CHARS)
    out["snippet"] = _clean_trim(out.get("snippet") or "", SNIPPET_MAX_CHARS) or None
    return out


def _clean_trim(text: str, max_chars: int) -> str:
    clean = re.sub(r"\s+", " ", text or "").strip()
    if len(clean) > max_chars:
        clean = clean[: max_chars - 1].rstrip() + "…"
    return clean


if __name__ == "__main__":
    raise SystemExit(main())
