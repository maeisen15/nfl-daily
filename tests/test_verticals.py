#!/usr/bin/env python3
"""Smoke test for the flat verticals: the article transform and the config the app reads.

Runs with plain `python3 tests/test_verticals.py` — no pytest needed. Exit 0 = pass.

Both fail silently when they regress. The transform drops items rather than erroring, which
looks like a quiet week, and a vertical that wrongly claims live tweets opens on a feed that
stays empty forever.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pipeline"))

import vertical_articles  # noqa: E402
import verticals  # noqa: E402

failures = []


def check(name, cond):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}")
    if not cond:
        failures.append(name)


NOW = datetime(2026, 11, 18, 12, 0, tzinfo=timezone.utc)


def iso(days_ago):
    return (NOW - timedelta(days=days_ago)).isoformat()


def raw(title, days_ago, url=None, **extra):
    return {"title": title, "url": url or f"https://example.com/{title}",
            "published_at": iso(days_ago) if days_ago is not None else None,
            "snippet": "", "author": None, "image": None, **extra}


SOURCES = [{"id": "a", "name": "Alpha", "rank": 10},
           {"id": "b", "name": "Beta", "max_items": 2}]

# ---------- build_items ----------
print("build_items:")
results = [
    {"source_id": "a", "items": [
        raw("fresh", 1, image="https://example.com/i.png"),
        raw("old", 30),
        raw("undated", None),
        raw("future", -2),
        raw("AT&amp;T", 2),
        raw("dupe", 3, url="https://example.com/same"),
    ]},
    {"source_id": "b", "items": [
        raw("dupe-again", 3, url="https://example.com/same"),
        raw("b1", 1), raw("b2", 2), raw("b3", 3),
    ]},
]
items = vertical_articles.build_items(SOURCES, results, "ai", 14, NOW)
titles = [i["title"] for i in items]
check("recent item kept", "fresh" in titles)
check("item older than the window dropped", "old" not in titles)
check("undated item dropped", "undated" not in titles)
check("future-dated item dropped", "future" not in titles)
check("HTML entities decoded in titles", "AT&T" in titles)
check("same URL from two sources kept once", titles.count("dupe") + titles.count("dupe-again") == 1)
check("max_items caps a source", sum(1 for i in items if i["source_id"] == "b") == 2)
check("newest first", [i["published_at"] for i in items]
      == sorted((i["published_at"] for i in items), reverse=True))
fresh = next(i for i in items if i["title"] == "fresh")
check("item carries the scope", fresh["scopes"] == ["ai"])
check("item is an article", fresh["type"] == "article")
check("source name and rank come from config",
      fresh["source_name"] == "Alpha" and fresh["source_rank"] == 10)
check("image becomes media", fresh["media"] == [{"type": "photo", "url": "https://example.com/i.png"}])
check("no image means empty media", next(i for i in items if i["title"] == "b1")["media"] == [])
check("unranked source gets the default rank",
      next(i for i in items if i["title"] == "b1")["source_rank"] == vertical_articles.DEFAULT_SOURCE_RANK)

# ---------- config_entries ----------
print("config_entries:")
real_handles = verticals.handles
try:
    verticals.handles = lambda v: [{"handle": "x"}] if v["code"] == "politics" else []
    entries = {e["code"]: e for e in verticals.config_entries()}
finally:
    verticals.handles = real_handles
check("every flat vertical is described", set(entries) == {v["code"] for v in verticals.FLAT})
check("a vertical with handles has live tweets and a Tweets tab",
      entries["politics"]["live_tweets"] and entries["politics"]["tabs"][0] == "tweets")
check("a vertical with no handles has neither",
      not entries["ai"]["live_tweets"] and "tweets" not in entries["ai"]["tabs"])
check("a vertical with no handles still has tabs", len(entries["ai"]["tabs"]) >= 1)
check("default scope is one of the vertical's scopes",
      all(e["default_scope"] in [s["code"] for s in e["scopes"]] for e in entries.values()))
check("data_dir is the vertical's own", entries["ai"]["data_dir"] == "data/ai")

# ---------- the real sources files ----------
print("sources files:")
for v in verticals.FLAT:
    ids = [s["id"] for s in verticals.news_sources(v)]
    check(f"{v['code']}: article source ids are unique", len(ids) == len(set(ids)))
    names = [tw["handle"].lower() for tw in verticals.load_sources(v).get("twitter_handles") or []]
    check(f"{v['code']}: handles are unique", len(names) == len(set(names)))
all_handles = [tw["handle"].lower() for v in verticals.FLAT
               for tw in verticals.load_sources(v).get("twitter_handles") or []]
check("no handle is claimed by two verticals", len(all_handles) == len(set(all_handles)))

print()
if failures:
    print(f"{len(failures)} FAILED: " + "; ".join(failures))
    sys.exit(1)
print("all checks passed")
