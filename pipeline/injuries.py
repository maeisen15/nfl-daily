#!/usr/bin/env python3
"""Snapshot the league's practice reports and keep the week's history in D1.

NFL.com publishes one table per team — player, position, injury, practice status, game status —
but only for the most recent practice. The report Matt actually reads is the accumulated grid:
Wednesday, Thursday, Friday side by side, with the game status appearing on Friday. That grid
only exists if somebody keeps yesterday's answer, so each run stores a dated snapshot and the
Worker assembles the week from them.

Storing it in D1 rather than the repo is what makes this work at all: the hourly job deploys
without committing, so a file written into web/data/ would be replaced, never accumulated.

    python3 pipeline/injuries.py
    python3 pipeline/injuries.py --dry-run

Costs nothing — NFL.com is a public page and the Worker is our own.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

REPO_ROOT = Path(__file__).resolve().parent.parent
SECRETS_FILE = Path(os.path.expanduser(os.environ.get("NFL_DAILY_SECRETS", "~/.nfl-digest/secrets.env")))
SCHEDULE_FILE = REPO_ROOT / "web" / "data" / "schedule.json"

SOURCE = "https://www.nfl.com/injuries/"
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                         "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"}
TIMEOUT = 25
EASTERN = ZoneInfo("America/New_York")

# NFL.com writes these out in full; the grid needs them short enough to sit in a column.
PRACTICE = {
    "did not participate in practice": "DNP",
    "limited participation in practice": "Limited",
    "full participation in practice": "Full",
}


def main() -> int:
    ap = argparse.ArgumentParser(description="Snapshot NFL practice reports")
    ap.add_argument("--dry-run", action="store_true", help="Parse and report; store nothing.")
    args = ap.parse_args()

    rows = fetch_rows()
    if not rows:
        # Out of season, or on a Monday or Tuesday, there is genuinely nothing to report. That
        # is not a failure, and storing an empty day would blank a grid that is still current.
        print("no practice rows on the page — nothing to store", file=sys.stderr)
        return 0

    day = datetime.now(EASTERN).strftime("%Y-%m-%d")
    teams = sorted({r["team"] for r in rows})
    print(f"{len(rows)} rows across {len(teams)} teams for {day}", file=sys.stderr)

    if args.dry_run:
        for team in teams[:3]:
            print(f"  {team}:", file=sys.stderr)
            for r in [x for x in rows if x["team"] == team][:4]:
                print(f"    {r['player']:<24} {r['position']:<4} {r['injury']:<14} "
                      f"{r['practice']:<8} {r['status']}", file=sys.stderr)
        return 0

    worker = (os.environ.get("NFL_DAILY_WORKER_URL") or "").rstrip("/")
    secret = load_secret("NFL_DAILY_PUSH_SECRET")
    if not (worker and secret):
        print("ERROR: NFL_DAILY_WORKER_URL and NFL_DAILY_PUSH_SECRET are required",
              file=sys.stderr)
        return 1

    res = requests.post(f"{worker}/injuries", json={"day": day, "rows": rows},
                        headers={"Authorization": f"Bearer {secret}"}, timeout=30)
    res.raise_for_status()
    print(f"stored: {json.dumps(res.json())}", file=sys.stderr)
    return 0


def fetch_rows() -> list[dict]:
    res = requests.get(SOURCE, headers=HEADERS, timeout=TIMEOUT)
    res.raise_for_status()
    soup = BeautifulSoup(res.text, "html.parser")
    names = team_name_map()

    rows: list[dict] = []
    # Each team's table is preceded by its own sub-title. Walking titles rather than tables
    # keeps a table attached to the right team even when a matchup has only one of them.
    for title in soup.select(".d3-o-section-sub-title"):
        team_name = clean(title.get_text())
        table = title.find_next("table")
        if not table or not team_name:
            continue
        abbr = names.get(team_name.lower())
        if not abbr:
            continue
        for tr in table.select("tbody tr"):
            cells = [clean(td.get_text()) for td in tr.select("td")]
            if len(cells) < 5 or not cells[0]:
                continue
            player, position, injury, practice, status = cells[:5]
            practice_short = PRACTICE.get(practice.lower(), practice)
            if not (practice_short or status):
                continue
            rows.append({
                "team": abbr, "player": player, "position": position,
                "injury": injury, "practice": practice_short, "status": status,
            })
    return rows


def team_name_map() -> dict[str, str]:
    """Short team name -> abbreviation, taken from the schedule this app already fetches so
    there is not a second hand-maintained list of thirty-two teams to keep in step."""
    out: dict[str, str] = {}
    try:
        data = json.loads(SCHEDULE_FILE.read_text())
    except (OSError, ValueError):
        print(f"warn: {SCHEDULE_FILE} missing — run pipeline/schedule.py first", file=sys.stderr)
        return out
    for week in data.get("weeks") or []:
        for game in week.get("games") or []:
            for side in (game.get("home"), game.get("away")):
                if side and side.get("name") and side.get("abbr"):
                    out[side["name"].lower()] = side["abbr"]
    return out


def clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


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
