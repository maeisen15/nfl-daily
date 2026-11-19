#!/usr/bin/env python3
"""Fetch article feeds for the flat verticals and write each one's feed.json.

Football's articles go through orchestrator.py and publish.py, which know about teams, rivals
and clustering the same story across outlets. A flat vertical needs none of that: its sources
are a handful of newsletters that rarely cover the same story, so this reads each feed, keeps
what is recent, and writes web/<data_dir>/feed.json in the shape the Articles tab already reads.

A feed that returns nothing looks exactly like a quiet week, so every source's count is printed
and carried in the file's source_health, and the script exits nonzero when a vertical that has
sources got nothing from any of them.

Usage:
    python3 pipeline/vertical_articles.py              # every flat vertical
    python3 pipeline/vertical_articles.py --only ai    # one of them
"""
from __future__ import annotations

import argparse
import html
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SKILL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SKILL_DIR))

import verticals  # noqa: E402
from fetchers import rss as rss_fetcher  # noqa: E402
from publish import SCHEMA_VERSION, DEFAULT_SOURCE_RANK, item_id, parse_dt  # noqa: E402

WEB_DIR = verticals.REPO_ROOT / "web"

# Newsletters publish weekly rather than hourly, so a football-sized window would leave the tab
# empty most days. A vertical's sources file can override this with `article_window_days:`.
DEFAULT_WINDOW_DAYS = 14
# Per source, so one daily writer can't push every weekly one off the screen.
DEFAULT_MAX_ITEMS = 8


def build_items(sources: list[dict[str, Any]], results: list[dict[str, Any]], scope: str,
                window_days: int, now: datetime) -> list[dict[str, Any]]:
    """Turn fetcher results into Articles-tab items: recent, dated, deduplicated by URL."""
    by_id = {s["id"]: s for s in sources}
    cutoff = now - timedelta(days=window_days)
    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for result in results:
        source = by_id[result["source_id"]]
        kept = 0
        for raw in result.get("items") or []:
            published = parse_dt(raw.get("published_at"))
            url = (raw.get("url") or "").strip()
            title = html.unescape(raw.get("title") or "").strip()
            # An undated item can't be placed under a day heading, and would sort to the top
            # forever if it were given today's date.
            if not published or not url or not title:
                continue
            if published < cutoff or published > now + timedelta(hours=1):
                continue
            if url in seen:
                continue
            if kept >= source.get("max_items", DEFAULT_MAX_ITEMS):
                break
            seen.add(url)
            kept += 1
            image = raw.get("image")
            items.append({
                "id": item_id(url),
                "type": "article",
                "scopes": [scope],
                "source_id": source["id"],
                "source_name": source.get("name") or source["id"],
                "title": title,
                "text": html.unescape(raw.get("snippet") or ""),
                "url": url,
                "published_at": published.isoformat(),
                "author_handle": None,
                "author_name": raw.get("author"),
                "team": None,
                "media": [{"type": "photo", "url": image}] if image else [],
                "source_rank": source.get("rank", DEFAULT_SOURCE_RANK),
                "cluster_size": 1,
            })
    items.sort(key=lambda i: i["published_at"], reverse=True)
    return items


def run_vertical(vertical: dict[str, Any], now: datetime) -> bool:
    """Fetch and write one vertical. Returns False when it has sources and none produced."""
    sources = verticals.news_sources(vertical)
    code = vertical["code"]
    if not sources:
        print(f"{code}: no article sources configured, nothing written")
        return True

    window_days = int(verticals.load_sources(vertical).get("article_window_days",
                                                           DEFAULT_WINDOW_DAYS))
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(rss_fetcher.fetch, sources))
    items = build_items(sources, results, vertical["scope"]["code"], window_days, now)

    in_window = {s["id"]: 0 for s in sources}
    for item in items:
        in_window[item["source_id"]] += 1

    print(f"{code}: {len(items)} articles in the last {window_days} days")
    for result in results:
        sid = result["source_id"]
        flag = "ok  " if result["status"] == "ok" else "FAIL"
        note = f" — {result['note']}" if result.get("note") else ""
        print(f"  {flag} {sid}: {result['items_fetched']} fetched, {in_window[sid]} kept{note}")

    out_dir = WEB_DIR / verticals.data_dir(vertical)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "feed.json"
    with path.open("w") as f:
        json.dump({
            "schema_version": SCHEMA_VERSION,
            "generated_at": now.isoformat(),
            "article_window_hours": window_days * 24,
            "counts": {"tweet": 0, "article": len(items), "transaction": 0, "injury": 0},
            "items": items,
            "source_health": [{"id": r["source_id"], "status": r["status"],
                               "items_fetched": r["items_fetched"],
                               "latency_ms": r["latency_ms"], "note": r["note"]}
                              for r in results],
        }, f, ensure_ascii=False, separators=(",", ":"))
    print(f"  wrote {path.relative_to(verticals.REPO_ROOT)}")

    if not any(r["items_fetched"] for r in results):
        print(f"ERROR: {code}: every article source returned nothing", file=sys.stderr)
        return False
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="Fetch articles for the flat verticals")
    ap.add_argument("--only", help="Vertical code to fetch instead of all of them")
    args = ap.parse_args()

    chosen = [v for v in verticals.FLAT if not args.only or v["code"] == args.only]
    if not chosen:
        print(f"ERROR: no such vertical: {args.only}", file=sys.stderr)
        return 2
    now = datetime.now(timezone.utc)
    ok = [run_vertical(v, now) for v in chosen]
    return 0 if all(ok) else 1


if __name__ == "__main__":
    sys.exit(main())
