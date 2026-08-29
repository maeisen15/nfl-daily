#!/usr/bin/env python3
"""Smoke test for the fragile, silent-failure-prone parts of the pipeline: date parsing, the
publish safety guard, the build_items transform (recency windows + team tagging), entity
decoding, and the digest-preservation rule.

Runs with plain `python3 tests/test_publish.py` — no pytest needed. Exit 0 = pass.

Why this test exists: date handling and the publish transform fail *silently* (they drop items
rather than error), so a regression would quietly empty the app. This locks in the behavior.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pipeline"))

import publish  # noqa: E402

failures = []


def check(name, cond):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}")
    if not cond:
        failures.append(name)


# ---------- parse_dt ----------
print("parse_dt:")
check("missing-seconds Z (ESPN shape)", publish.parse_dt("2026-05-21T07:00Z") is not None)
check("full offset ISO", publish.parse_dt("2026-07-25T10:00:41+00:00") is not None)
check("missing-seconds becomes UTC-aware",
      (publish.parse_dt("2026-07-24T07:00Z")).utcoffset().total_seconds() == 0)
check("None → None", publish.parse_dt(None) is None)
check("garbage → None", publish.parse_dt("not a date") is None)

# ---------- publish_ok (safety guard) ----------
print("publish_ok:")
ok, _ = publish.publish_ok([], [{"status": "ok"}])
check("0 items → blocked", ok is False)
ok, _ = publish.publish_ok([{"x": 1}], [{"status": "ok"}, {"status": "ok"}, {"status": "warn"}])
check("healthy run → allowed", ok is True)
ok, _ = publish.publish_ok([{"x": 1}], [{"status": "error"}, {"status": "error"}, {"status": "ok"}])
check(">50% errored → blocked", ok is False)

# ---------- build_items ----------
print("build_items:")
COMPLETED = "2026-07-26T22:00:00+00:00"  # fixture "now"; cutoffs derive from this
run = {
    "run_id": "test",
    "completed_at": COMPLETED,
    "recency_hours_cap": 24,
    "source_health": {"espn_transactions": {"status": "ok"}},
    "tweet_feeds": {
        "national": [
            {"tweet_id": "t_in", "author_handle": "AdamSchefter", "author_name": "Adam Schefter",
             "text": "in window", "url": "https://x.com/a/status/t_in",
             "published_at": "2026-07-26T12:00:00+00:00"},  # 10h old → kept
            {"tweet_id": "t_out", "author_handle": "AdamSchefter", "author_name": "Adam Schefter",
             "text": "too old", "url": "https://x.com/a/status/t_out",
             "published_at": "2026-07-25T16:00:00+00:00"},  # 30h old → dropped (tweets = 24h)
        ],
        "ravens": [], "rivals": {"PIT": []},
    },
    "raw_items": [
        {"source_id": "espn_nfl", "title": "Article 30h old", "url": "https://espn.com/a1",
         "published_at": "2026-07-25T16:00:00+00:00", "snippet": "x"},  # 30h → kept (articles = 48h)
        {"source_id": "espn_nfl", "title": "Article 60h old", "url": "https://espn.com/a2",
         "published_at": "2026-07-24T10:00:00+00:00", "snippet": "x"},  # 60h → dropped
        {"source_id": "espn_nfl", "title": "Dateless article", "url": "https://espn.com/a3",
         "published_at": None, "snippet": "x"},  # dropped
        {"source_id": "espn_transactions",
         "title": "Pittsburgh Steelers: Claimed WR off waivers from Arizona Cardinals",
         "team": "Pittsburgh Steelers", "url": "https://espn.com/nfl/transactions",
         "published_at": "2026-07-26T17:00Z", "snippet": None},  # 5h → kept; must tag PIT not ARI
        {"source_id": "espn_injuries", "title": "Lamar Jackson (QB) — Baltimore Ravens [questionable]: Questionable",
         "team": "Baltimore Ravens", "url": "https://espn.com/nfl/injuries",
         "published_at": "2026-07-26T18:00:00+00:00", "snippet": "questionable"},  # kept, BAL
    ],
}
items, window_hours, article_window_hours = publish.build_items(run, "BAL", ["PIT"])
by_type = {}
for it in items:
    by_type.setdefault(it["type"], []).append(it)

check("windows: 24h base / 48h articles", window_hours == 24 and article_window_hours == 48)
check("1 tweet kept (out-of-window dropped)", len(by_type.get("tweet", [])) == 1)
check("1 article kept (60h + dateless dropped)", len(by_type.get("article", [])) == 1)
check("1 transaction kept", len(by_type.get("transaction", [])) == 1)
check("1 injury kept", len(by_type.get("injury", [])) == 1)

txn = by_type.get("transaction", [{}])[0]
check("transaction tagged PIT via authoritative team (not ARI from title scan)",
      txn.get("team") == "PIT" and "PIT" in txn.get("scopes", []))
inj = by_type.get("injury", [{}])[0]
check("injury tagged BAL", inj.get("team") == "BAL" and "BAL" in inj.get("scopes", []))

# ---------- clean_text ----------
# Publishers leave HTML entities in feed content. The app escapes once at render, so an entity
# surviving to here gets escaped twice and reaches the screen as a literal "&amp;".
print("clean_text:")
check("&amp; becomes &", publish.clean_text("Schatz &amp; Tanier") == "Schatz & Tanier")
check("numeric entity becomes the character",
      publish.clean_text("The Athletic&#8217;s") == "The Athletic\u2019s")
check("double-encoded entity fully resolves",
      publish.clean_text("&amp;#8217;") == "\u2019")
check("plain text is untouched", publish.clean_text("no entities here") == "no entities here")
check("None passes through", publish.clean_text(None) is None)
check("control characters stripped", "\x00" not in publish.clean_text("bad\x00char"))

# ---------- digest preservation ----------
# The hourly refresh publishes runs that carry no digest_outputs. If those rewrote digest.json
# the Home tab would blank between synthesis runs, so build_digest must yield nothing and let
# publish.py keep the existing file.
print("digest preservation:")
primary = {"team_code": "BAL", "display_name": "Baltimore Ravens"}
rivals = [{"team_code": "PIT", "display_name": "Pittsburgh Steelers"}]
check("fetch-only run yields no tabs",
      publish.build_digest({"digest_outputs": None}, primary, rivals) == [])
check("empty digest_outputs yields no tabs",
      publish.build_digest({"digest_outputs": {}}, primary, rivals) == [])
synth = {"digest_outputs": {"national": {"full_markdown": "## A"},
                            "ravens": {"full_markdown": "## B"},
                            "rivals": {"PIT": {"full_markdown": "## C"}}}}
tabs = publish.build_digest(synth, primary, rivals)
check("synthesis run yields one tab per scope", len(tabs) == 3)
check("primary tab is labelled from config",
      any(t["scope"] == "BAL" and t["label"] == "Baltimore Ravens" for t in tabs))

print()
if failures:
    print(f"{len(failures)} FAILURE(S): {failures}")
    sys.exit(1)
print("all checks passed")
