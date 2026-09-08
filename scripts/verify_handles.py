#!/usr/bin/env python3
"""Check that every handle in config/sources.yaml resolves to a real X account.

A misspelled handle is the worst kind of bug this app has: the poll query accepts it, the
search returns nothing for it, and nothing anywhere reports a problem. It simply contributes
no tweets forever. Run this after editing the handle list and before syncing it:

    python3 scripts/verify_handles.py
    python3 scripts/verify_handles.py --only jamisonhensley,ryanmink

Cost is real but trivial — a profile lookup is 18 credits, so checking all of them runs about
half a cent. Cheaper than one day of a handle silently contributing nothing.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import requests
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "pipeline"))

SOURCES_FILE = Path(os.environ.get("NFL_DAILY_SOURCES", REPO_ROOT / "config" / "sources.yaml"))
SECRETS_FILE = Path(os.path.expanduser(os.environ.get("NFL_DAILY_SECRETS", "~/.nfl-digest/secrets.env")))
API_BASE = "https://api.twitterapi.io"
TIMEOUT = 20


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify X handles resolve")
    ap.add_argument("--only", help="Comma-separated handles to check instead of the whole config")
    args = ap.parse_args()

    key = load_secret("TWITTERAPI_IO_KEY")
    if not key:
        print("ERROR: TWITTERAPI_IO_KEY not set (env or ~/.nfl-digest/secrets.env)", file=sys.stderr)
        return 1

    if args.only:
        entries = [(h.strip().lstrip("@"), "(ad hoc)") for h in args.only.split(",") if h.strip()]
    else:
        entries = collect_handles(yaml.safe_load(SOURCES_FILE.read_text()))

    print(f"{len(entries)} handles -> {API_BASE}\n")
    bad, renamed = [], []
    for handle, where in entries:
        info = lookup(key, handle)
        if info is None:
            print(f"  MISS  @{handle:<20} {where} — does not resolve")
            bad.append(handle)
            continue
        actual = info.get("userName") or handle
        followers = info.get("followers") or 0
        note = f"{info.get('name','')} · {followers:,} followers"
        # A handle that resolves under different capitalisation is fine; one that resolves to a
        # different name has been reassigned, which is worse than a typo — it silently watches
        # a stranger.
        if actual.lower() != handle.lower():
            print(f"  MOVED @{handle:<20} {where} — now @{actual} ({note})")
            renamed.append((handle, actual))
        else:
            print(f"  ok    @{handle:<20} {where} — {note}")

    print()
    if bad:
        print(f"{len(bad)} handle(s) do not resolve — fix before syncing: " + ", ".join(bad))
    if renamed:
        print(f"{len(renamed)} handle(s) redirect: " + ", ".join(f"{a}->{b}" for a, b in renamed))
    if not bad and not renamed:
        print("All handles resolve.")
    return 1 if bad else 0


def lookup(key: str, handle: str) -> dict | None:
    try:
        res = requests.get(f"{API_BASE}/twitter/user/info", params={"userName": handle},
                           headers={"X-API-Key": key}, timeout=TIMEOUT)
    except requests.RequestException as err:
        print(f"  ERR   @{handle}: {err}", file=sys.stderr)
        return None
    if res.status_code != 200:
        return None
    body = res.json() if res.content else {}
    data = body.get("data") or body.get("userData") or {}
    return data or None


def collect_handles(config: dict) -> list[tuple[str, str]]:
    """Every watched handle with the config section it came from, for a legible report."""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(entries, where):
        for entry in entries or []:
            if not entry.get("enabled", True):
                continue
            handle = (entry.get("handle") or "").lstrip("@")
            if not handle or handle.lower() in seen:
                continue
            seen.add(handle.lower())
            out.append((handle, where))

    add(config.get("twitter_news_handles"), "national news")
    add(config.get("twitter_analysis_handles"), "national analysis")
    team = config.get("team_coverage") or {}
    add((team.get("primary") or {}).get("twitter_handles"), "ravens")
    for rival in team.get("rivals") or []:
        add(rival.get("twitter_handles"), f"rival {rival.get('team_code','?')}")
    return out


def load_secret(name: str) -> str | None:
    if os.environ.get(name):
        return os.environ[name]
    if SECRETS_FILE.exists():
        for line in SECRETS_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip() == name:
                return v.strip().strip('"').strip("'")
    return None


if __name__ == "__main__":
    raise SystemExit(main())
