#!/usr/bin/env python3
"""Smoke test for the fragile, silent-failure-prone parts of the pipeline: date parsing, the
publish safety guard, the build_items transform (recency windows, team tagging, article images,
source ranks), article clustering, entity decoding, and the digest-preservation rule.

Runs with plain `python3 tests/test_publish.py` — no pytest needed. Exit 0 = pass.

Why this test exists: date handling and the publish transform fail *silently* (they drop items
rather than error), so a regression would quietly empty the app. Clustering fails silently in
the same way and worse — a threshold regression hides articles Matt can never discover — so
the negative cases below (near-misses that must NOT merge) matter more than the positive ones.
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
         "published_at": "2026-07-25T16:00:00+00:00", "snippet": "x",
         "image": "https://a.espncdn.com/photo.jpg"},  # 30h → kept (articles = 48h)
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
items, window_hours, article_window_hours = publish.build_items(
    run, "BAL", ["PIT"], {"espn_nfl": 20})
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
      txn.get("team") == "PIT")
check("a rival's transaction is scoped to the shared rivals tab",
      "rivals" in txn.get("scopes", []) and "PIT" not in txn.get("scopes", []))
inj = by_type.get("injury", [{}])[0]
check("injury tagged BAL", inj.get("team") == "BAL" and "BAL" in inj.get("scopes", []))

art = by_type.get("article", [{}])[0]
check("article image lands in media[0] as a photo entry",
      art.get("media") == [{"type": "photo", "url": "https://a.espncdn.com/photo.jpg"}])
check("article carries source_rank from config", art.get("source_rank") == 20)
check("article carries cluster_size", art.get("cluster_size") == 1)

# ---------- source_rank default ----------
# A source with no `rank:` in sources.yaml must still publish, sorting below every ranked one.
print("source_rank default:")
unranked = {**run, "raw_items": [
    {"source_id": "some_new_source", "title": "Unranked source article",
     "url": "https://example.com/x", "published_at": "2026-07-26T12:00:00+00:00",
     "snippet": "x"},
], "tweet_feeds": {"national": [], "ravens": [], "rivals": {}}}
u_items, _, _ = publish.build_items(unranked, "BAL", ["PIT"], {})
check("unset rank defaults to 99", u_items[0].get("source_rank") == 99)
check("article with no image gets an empty media array", u_items[0].get("media") == [])

# ---------- title normalization ----------
print("title normalization:")
toks = publish.normalize_title_tokens("The Ravens' Lamar Jackson, per report, is QUESTIONABLE!")
check("lowercased, depunctuated, possessive stripped", {"ravens", "lamar", "jackson"} <= toks)
check("stopwords and filler dropped", "the" not in toks and "report" not in toks)
check("empty title yields no tokens", publish.normalize_title_tokens(None) == set())
check("canonical_url ignores scheme, www, query and trailing slash",
      publish.canonical_url("https://www.espn.com/nfl/story/1/?utm=x")
      == publish.canonical_url("http://espn.com/nfl/story/1"))

# ---------- article clustering ----------
# The same story from three outlets becomes one item, kept from the best-ranked source. Tuned
# conservative: a missed merge is invisible to Matt, a wrong merge hides an article from him.
print("article clustering:")


def article(sid, rank, title, url, published="2026-07-26T12:00:00+00:00", scopes=("national",)):
    return {"id": url, "type": "article", "scopes": list(scopes), "source_id": sid,
            "source_name": sid, "title": title, "text": None, "url": url,
            "published_at": published, "author_handle": None, "author_name": None,
            "team": None, "media": [], "source_rank": rank}


DUPES = [
    article("cbs_nfl", 30, "Cowboys guard Tyler Smith to have thumb surgery, expected to miss 4-6 weeks",
            "https://cbssports.com/1"),
    article("espn_nfl", 20, "Cowboys' Tyler Smith to undergo thumb surgery, out 4-6 weeks",
            "https://espn.com/1"),
    article("fox_nfl", 40, "Cowboys guard Tyler Smith undergoes thumb surgery, will miss 4-6 weeks",
            "https://foxsports.com/1"),
]
clustered, merged = publish.cluster_articles([dict(a) for a in DUPES])
check("three outlets on one story collapse to one item", len(clustered) == 1 and merged == 2)
check("the highest-ranked source survives", clustered[0]["source_id"] == "espn_nfl")
check("survivor reports cluster_size 3", clustered[0]["cluster_size"] == 3)

DISTINCT = [
    article("espn_nfl", 20, "Ravens sign veteran cornerback to one-year deal",
            "https://espn.com/2"),
    article("cbs_nfl", 30, "Ravens release veteran linebacker in roster move",
            "https://cbssports.com/2"),
    article("fox_nfl", 40, "Steelers name rookie starting quarterback for Week 1",
            "https://foxsports.com/2"),
]
clustered, merged = publish.cluster_articles([dict(a) for a in DISTINCT])
check("different stories are never merged", len(clustered) == 3 and merged == 0)

FAR_APART = [
    article("espn_nfl", 20, "Cowboys' Tyler Smith to undergo thumb surgery, out 4-6 weeks",
            "https://espn.com/3", published="2026-07-20T12:00:00+00:00"),
    article("cbs_nfl", 30, "Cowboys' Tyler Smith to undergo thumb surgery, out 4-6 weeks",
            "https://cbssports.com/3", published="2026-07-26T12:00:00+00:00"),
]
clustered, merged = publish.cluster_articles([dict(a) for a in FAR_APART])
check("identical titles 6 days apart stay separate", len(clustered) == 2 and merged == 0)

CROSS_SCOPE = [
    article("espn_nfl", 20, "Cowboys' Tyler Smith to undergo thumb surgery, out 4-6 weeks",
            "https://espn.com/4", scopes=("national",)),
    article("ravens_news_sun", 30, "Cowboys' Tyler Smith to undergo thumb surgery, out 4-6 weeks",
            "https://baltimoresun.com/4", scopes=("BAL",)),
]
clustered, merged = publish.cluster_articles([dict(a) for a in CROSS_SCOPE])
check("articles in different scopes never merge", len(clustered) == 2 and merged == 0)

SAME_URL = [
    article("espn_nfl", 20, "One headline about a football game", "https://espn.com/5/"),
    article("cbs_nfl", 30, "A completely unrelated set of words", "https://www.espn.com/5?src=rss"),
]
clustered, merged = publish.cluster_articles([dict(a) for a in SAME_URL])
check("the same URL is the same story regardless of title",
      len(clustered) == 1 and clustered[0]["source_id"] == "espn_nfl")

# Two tellings of one story from equally-ranked outlets: the later one is the one that knows
# how it ended, and it is the one the reader should get.
SAME_RANK = [
    article("cbs_nfl", 30, "Ravens place kicker Justin Tucker on injured reserve",
            "https://cbssports.com/7", published="2026-07-26T09:00:00+00:00"),
    article("fox_nfl", 30, "Ravens put kicker Justin Tucker on injured reserve",
            "https://foxsports.com/7", published="2026-07-26T15:00:00+00:00"),
]
clustered, merged = publish.cluster_articles([dict(a) for a in SAME_RANK])
check("among equal ranks the newest telling leads",
      len(clustered) == 1 and clustered[0]["source_id"] == "fox_nfl")

NEAR_MISS = [
    article("espn_nfl", 20, "Cowboys Pro Bowl guard Tyler Smith headed for injured reserve",
            "https://espn.com/6"),
    article("cbs_nfl", 30, "Cowboys left guard Tyler Smith will not practice Wednesday",
            "https://cbssports.com/6"),
]
clustered, merged = publish.cluster_articles([dict(a) for a in NEAR_MISS])
check("only-probably-the-same articles are both kept (bias to under-merge)",
      len(clustered) == 2 and merged == 0)

mixed = [dict(DUPES[0]), {"id": "t1", "type": "tweet", "scopes": ["national"],
                          "published_at": "2026-07-26T12:00:00+00:00"}]
clustered, merged = publish.cluster_articles(mixed)
check("non-article items pass through with cluster_size 1",
      len(clustered) == 2 and all(i["cluster_size"] == 1 for i in clustered))

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
