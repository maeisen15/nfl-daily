#!/usr/bin/env python3
"""Fetch the league's schedule, scores and standings into web/data/schedule.json.

Standalone, like tweets.py, rather than a fetcher inside the orchestrator: this is a snapshot
of the whole season rather than a stream of items, and carrying ninety kilobytes of it through
every run log would bloat the logs for nothing.

    python3 pipeline/schedule.py

Everything here comes from ESPN's public site API, which costs nothing and needs no key. It
sits behind Akamai, which answers 403 to `site.api.espn.com` often enough that the alternate
host has to be tried — see fetchers/espn_api.py, which learned this the hard way.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DEFAULT = REPO_ROOT / "web" / "data" / "schedule.json"
SCHEMA_VERSION = 1

HOSTS = ("site.web.api.espn.com", "site.api.espn.com")
# The season is selected with `dates`, not `year`. A `year` parameter is accepted and then
# silently ignored, returning the current season instead — which looks like working code right
# up until someone asks for a season that is not this one.
SCOREBOARD = "/apis/site/v2/sports/football/nfl/scoreboard"
STANDINGS = "/apis/v2/sports/football/nfl/standings"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Referer": "https://www.espn.com/",
    "Origin": "https://www.espn.com",
}
TIMEOUT = 20

# Regular season is type 2, postseason type 3. Weeks 1-18 and the four playoff rounds cover a
# whole season; asking for a week that does not exist yet simply returns nothing.
REGULAR_WEEKS = range(1, 19)
POSTSEASON_WEEKS = {1: "Wild Card", 2: "Divisional", 3: "Conference Championship", 5: "Super Bowl"}


def main() -> int:
    ap = argparse.ArgumentParser(description="Fetch NFL schedule, scores and standings")
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    ap.add_argument("--year", type=int, default=None, help="Season year (default: current)")
    args = ap.parse_args()

    year = args.year or guess_season_year()
    weeks, current = fetch_weeks(year)
    if not weeks:
        print("ERROR: no weeks returned — refusing to write an empty schedule", file=sys.stderr)
        return 1

    standings = fetch_standings()
    payload = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "season": {"year": year},
        "current_week": current,
        "weeks": weeks,
        "standings": standings,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    games = sum(len(w["games"]) for w in weeks)
    print(f"wrote {out} ({out.stat().st_size // 1024} KB) — "
          f"{len(weeks)} weeks, {games} games, current week {current}, "
          f"{sum(len(d['teams']) for c in standings for d in c['divisions'])} teams in standings")
    return 0


def guess_season_year() -> int:
    """A season is named for the year it starts, so January and February belong to the year
    before. Getting this wrong asks for a season that does not exist and returns nothing."""
    now = datetime.now(timezone.utc)
    return now.year - 1 if now.month <= 2 else now.year


def fetch_weeks(year: int) -> tuple[list[dict], int | None]:
    weeks: list[dict] = []
    current = None

    for week in REGULAR_WEEKS:
        data = get(SCOREBOARD, {"week": week, "seasontype": 2, "dates": year})
        games = [parse_game(e) for e in (data.get("events") or [])]
        if not games:
            continue
        weeks.append({"week": week, "season_type": 2, "label": f"Week {week}", "games": games})

    for week, label in POSTSEASON_WEEKS.items():
        data = get(SCOREBOARD, {"week": week, "seasontype": 3, "dates": year})
        games = [parse_game(e) for e in (data.get("events") or [])]
        if games:
            weeks.append({"week": 18 + week, "season_type": 3, "label": label, "games": games})

    # The week to open on is the first with a game still to play; once the season is over it is
    # the last one, so the app lands on results rather than an empty screen.
    for w in weeks:
        if any(g["state"] != "post" for g in w["games"]):
            current = w["week"]
            break
    if current is None and weeks:
        current = weeks[-1]["week"]
    return weeks, current


def parse_game(event: dict) -> dict:
    comp = (event.get("competitions") or [{}])[0]
    status = event.get("status") or {}
    stype = status.get("type") or {}
    sides = {}
    for c in comp.get("competitors") or []:
        sides[c.get("homeAway")] = parse_side(c)
    # ESPN reports 0 for a game that has not kicked off. Rendering that is a lie the size of a
    # scoreline, so an unplayed game carries no score at all.
    if stype.get("state") == "pre":
        for side in sides.values():
            if side:
                side["score"] = None
    return {
        "id": event.get("id"),
        "date": event.get("date"),
        "state": stype.get("state"),            # pre | in | post
        "completed": bool(stype.get("completed")),
        # "Final", "Scheduled", or a live "Q3 8:22" — ESPN already phrases this for display.
        "status": stype.get("shortDetail") if stype.get("state") == "in" else stype.get("description"),
        "period": status.get("period") or 0,
        "clock": status.get("displayClock"),
        "network": network_of(comp),
        "venue": ((comp.get("venue") or {}).get("fullName")),
        "neutral": bool(comp.get("neutralSite")),
        "home": sides.get("home"),
        "away": sides.get("away"),
    }


def parse_side(c: dict) -> dict:
    team = c.get("team") or {}
    overall = next((r.get("summary") for r in (c.get("records") or [])
                    if r.get("type") == "total"), None)
    score = c.get("score")
    return {
        "abbr": team.get("abbreviation"),
        "name": team.get("shortDisplayName") or team.get("name"),
        "full": team.get("displayName"),
        "color": team.get("color"),
        "record": overall,
        "score": int(score) if str(score).isdigit() else None,
        "winner": bool(c.get("winner")),
    }


def network_of(comp: dict) -> str | None:
    for b in comp.get("broadcasts") or []:
        names = b.get("names") or []
        if names:
            return names[0]
    return None


def fetch_standings() -> list[dict]:
    """Conference -> division -> teams. ESPN nests these as `children` two deep."""
    data = get(STANDINGS, {"level": 3})
    out = []
    for conf in data.get("children") or []:
        divisions = []
        for div in conf.get("children") or []:
            teams = []
            for entry in ((div.get("standings") or {}).get("entries") or []):
                stats = {s.get("name"): s for s in entry.get("stats") or []}
                team = entry.get("team") or {}
                teams.append({
                    "abbr": team.get("abbreviation"),
                    "name": team.get("shortDisplayName") or team.get("displayName"),
                    "wins": num(stats.get("wins")),
                    "losses": num(stats.get("losses")),
                    "ties": num(stats.get("ties")),
                    "pct": (stats.get("winPercent") or {}).get("displayValue"),
                    "points_for": num(stats.get("pointsFor")),
                    "points_against": num(stats.get("pointsAgainst")),
                    "streak": (stats.get("streak") or {}).get("displayValue"),
                })
            if teams:
                divisions.append({"name": div.get("name") or div.get("shortName"), "teams": teams})
        if divisions:
            out.append({"name": conf.get("abbreviation") or conf.get("name"), "divisions": divisions})
    return out


def num(stat: dict | None):
    if not stat:
        return None
    value = stat.get("value")
    return int(value) if isinstance(value, (int, float)) else None


def get(path: str, params: dict) -> dict:
    """Try both hosts. Akamai answers 403 to one of them often enough that a single host makes
    the whole fetch flaky for no reason."""
    last = None
    for host in HOSTS:
        try:
            res = requests.get(f"https://{host}{path}", params=params,
                               headers=HEADERS, timeout=TIMEOUT)
            if res.ok:
                return res.json()
            last = f"{host} -> HTTP {res.status_code}"
        except requests.RequestException as err:
            last = f"{host} -> {err}"
    print(f"warn: {path} {params}: {last}", file=sys.stderr)
    return {}


if __name__ == "__main__":
    raise SystemExit(main())
