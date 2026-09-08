#!/usr/bin/env python3
"""Assemble the Ravens game-week dossier into web/data/gameweek.json.

The Ravens brief is not a summary of the day. It answers whether you are ready for Sunday, and
it builds through the week: the matchup and the statistical picture early, practice reports
accumulating Wednesday to Friday, designations and weather by Saturday.

Almost all of it is structured data, so it is assembled here rather than written by a model. A
model summarising a table of practice participation would only introduce a way for it to be
wrong. The written summary still sits below this, in the digest.

    python3 pipeline/gameweek.py

Costs nothing: ESPN and Open-Meteo are public and free, and the injury grid comes from our own
Worker, which the injuries snapshot has already filled.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "pipeline"))

from data.stadiums import STADIUMS  # noqa: E402

SCHEDULE_FILE = REPO_ROOT / "web" / "data" / "schedule.json"
FEED_FILE = REPO_ROOT / "web" / "data" / "feed.json"
OUT_DEFAULT = REPO_ROOT / "web" / "data" / "gameweek.json"
SCHEMA_VERSION = 1

HOSTS = ("site.web.api.espn.com", "site.api.espn.com")
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Referer": "https://www.espn.com/",
    "Origin": "https://www.espn.com",
}
WEATHER_API = "https://api.open-meteo.com/v1/forecast"
TIMEOUT = 20

# ESPN's numeric team ids, which its per-team endpoints need and its scoreboard does not give.
ESPN_IDS = {
    "ATL": 1, "BUF": 2, "CHI": 3, "CIN": 4, "CLE": 5, "DAL": 6, "DEN": 7, "DET": 8,
    "GB": 9, "TEN": 10, "IND": 11, "KC": 12, "LV": 13, "LAR": 14, "MIA": 15, "MIN": 16,
    "NE": 17, "NO": 18, "NYG": 19, "NYJ": 20, "PHI": 21, "ARI": 22, "PIT": 23, "LAC": 24,
    "SF": 25, "SEA": 26, "TB": 27, "WSH": 28, "CAR": 29, "JAX": 30, "BAL": 33, "HOU": 34,
}

# The comparison worth reading at a glance: label, ESPN stat name.
MEASURES = [
    ("Points/gm", "totalPointsPerGame"),
    ("Yards/gm", "yardsPerGame"),
    ("Pass/gm", "netPassingYardsPerGame"),
    ("Rush/gm", "rushingYardsPerGame"),
]


def main() -> int:
    ap = argparse.ArgumentParser(description="Build the Ravens game-week dossier")
    ap.add_argument("--team", default="BAL")
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    args = ap.parse_args()

    schedule = load_schedule()
    if not schedule:
        return 1
    game, week_label, previous = next_game(schedule, args.team)
    if not game:
        print("no upcoming game for this team — writing an empty dossier", file=sys.stderr)
        write(args.out, {"schema_version": SCHEMA_VERSION,
                         "generated_at": now_iso(), "game": None})
        return 0

    home, away = game["home"], game["away"]
    opponent = away["abbr"] if home["abbr"] == args.team else home["abbr"]
    print(f"{week_label}: {away['abbr']} at {home['abbr']} — {game['date']}", file=sys.stderr)

    payload = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": now_iso(),
        "team": args.team,
        "opponent": opponent,
        "week_label": week_label,
        "game": game,
        # Away on the left, home on the right, which is how a matchup is written everywhere.
        "stats": team_stats(away["abbr"], home["abbr"]),
        "injuries": injuries(args.team, opponent, previous),
        "weather": weather(game),
        "previews": previews(game, args.team, opponent),
        "opponent_beat": beat_writer(opponent),
    }
    write(args.out, payload)
    return 0


def load_schedule() -> dict | None:
    try:
        return json.loads(SCHEDULE_FILE.read_text())
    except (OSError, ValueError):
        print(f"ERROR: {SCHEDULE_FILE} missing — run pipeline/schedule.py first", file=sys.stderr)
        return None


def next_game(schedule: dict, team: str) -> tuple[dict | None, str, dict | None]:
    """The game still to be played, the week it falls in, and the one before it.

    Deliberately not "the current week's game": a team on a bye still has a next opponent, and
    a dossier about nothing is worse than one that looks ahead. The previous game is what bounds
    the injury grid to a single week."""
    played = None
    for week in schedule.get("weeks") or []:
        for game in week.get("games") or []:
            if team not in (game["home"]["abbr"], game["away"]["abbr"]):
                continue
            if game.get("state") != "post":
                return game, week.get("label", ""), (played[0] if played else None)
            played = (game, week.get("label", ""))
    if played:
        return played[0], played[1], None
    return None, "", None


def team_stats(away: str, home: str) -> dict | None:
    """Both sides of the matchup, offence and defence, with league ranks.

    Ranks are computed here rather than read from ESPN. ESPN fills in `rank` on the opponent
    side and leaves it null on a team's own production, so taking its word would produce a
    table with ranked defence and blank offence. Ranking thirty-two numbers costs nothing and
    treats both halves the same."""
    league = league_stats()
    if not league or away not in league or home not in league:
        return None
    ranks = compute_ranks(league)
    return {
        "away": away, "home": home,
        "offense": rows(league, ranks, "own", away, home),
        "defense": rows(league, ranks, "opponent", away, home),
    }


def rows(league, ranks, side, away, home) -> list[dict]:
    out = []
    for label, name in MEASURES:
        a = cell(league, ranks, side, name, away)
        b = cell(league, ranks, side, name, home)
        if not a and not b:
            continue
        out.append({
            "label": label, "away": a, "home": b,
            # Which side is better, so the app can mark it without having to know that few
            # points allowed is good and few points scored is not.
            "better": better_side(a, b),
        })
    return out


def cell(league, ranks, side, name, abbr):
    value = (league.get(abbr) or {}).get(side, {}).get(name)
    if value is None:
        return None
    return {"value": fmt(value), "rank": ranks.get((side, name), {}).get(abbr)}


def better_side(a, b) -> str | None:
    ra, rb = (a or {}).get("rank"), (b or {}).get("rank")
    if not isinstance(ra, int) or not isinstance(rb, int) or ra == rb:
        return None
    return "away" if ra < rb else "home"


def compute_ranks(league: dict) -> dict:
    """Rank 1 is the best. Scoring and gaining yards is better high; allowing either is better
    low, which is the only thing that differs between the two halves of the table."""
    out = {}
    for side in ("own", "opponent"):
        for _label, name in MEASURES:
            pairs = [(abbr, teams[side][name]) for abbr, teams in league.items()
                     if isinstance(teams.get(side, {}).get(name), (int, float))]
            if not pairs:
                continue
            pairs.sort(key=lambda p: p[1], reverse=(side == "own"))
            out[(side, name)] = {abbr: i + 1 for i, (abbr, _v) in enumerate(pairs)}
    return out


def league_stats() -> dict:
    """Every team's per-game numbers. Thirty-two free requests, run in parallel."""
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda a: (a, fetch_stats(a)), ESPN_IDS))
    return {abbr: stats for abbr, stats in results if stats}


def fetch_stats(abbr: str) -> dict | None:
    team_id = ESPN_IDS.get(abbr)
    if not team_id:
        return None
    data = espn(f"/apis/site/v2/sports/football/nfl/teams/{team_id}/statistics", {})
    results = data.get("results") or {}
    # `stats` arrives wrapped in an object with a `categories` list; `opponent` is that list
    # directly. Same content, two shapes.
    own_groups = (results.get("stats") or {}).get("categories") or []
    opp_groups = results.get("opponent") or []
    out = {"own": flatten(own_groups), "opponent": flatten(opp_groups)}
    return out if out["own"] else None


def flatten(groups) -> dict:
    """Stat name -> numeric value. ESPN repeats some names across categories; the first wins."""
    flat = {}
    for group in groups or []:
        if not isinstance(group, dict):
            continue
        for stat in group.get("stats") or []:
            name = stat.get("name")
            if name and name not in flat and isinstance(stat.get("value"), (int, float)):
                flat[name] = stat["value"]
    return flat


def fmt(value) -> str:
    return f"{value:.1f}" if isinstance(value, float) else str(value)


def injuries(team: str, opponent: str, previous: dict | None) -> dict | None:
    worker = (os.environ.get("NFL_DAILY_WORKER_URL") or "").rstrip("/")
    if not worker:
        print("warn: NFL_DAILY_WORKER_URL not set — no injury grid", file=sys.stderr)
        return None
    params = {"teams": f"{team},{opponent}", "days": 8}
    # The grid covers one game week. Without this bound a Wednesday run shows last Wednesday's
    # column beside this one, which reads as two contradictory reports for the same player.
    last = parse_iso((previous or {}).get("date"))
    if last:
        params["since"] = (last.date() + timedelta(days=1)).isoformat()
    try:
        res = requests.get(f"{worker}/injuries", params=params, timeout=TIMEOUT)
        res.raise_for_status()
        return res.json()
    except requests.RequestException as err:
        print(f"warn: injury grid unavailable: {err}", file=sys.stderr)
        return None


def weather(game: dict) -> dict | None:
    """Conditions at kickoff, for outdoor and retractable venues.

    A retractable roof still gets a forecast: whether it is open is a game-day decision, so the
    weather is what decides it rather than being irrelevant."""
    if game.get("neutral"):
        return {"roof": "neutral", "venue": game.get("venue")}
    venue = STADIUMS.get(game["home"]["abbr"])
    if not venue:
        return None
    if venue["roof"] == "dome":
        return {"roof": "dome", "venue": venue["name"]}

    kickoff = parse_iso(game.get("date"))
    if not kickoff:
        return None
    days_out = (kickoff - datetime.now(timezone.utc)).days
    # Open-Meteo forecasts sixteen days; beyond that the answer would be invented.
    if days_out > 15 or days_out < -1:
        return {"roof": venue["roof"], "venue": venue["name"], "forecast": None}

    try:
        res = requests.get(WEATHER_API, timeout=TIMEOUT, params={
            "latitude": venue["lat"], "longitude": venue["lon"],
            "hourly": "temperature_2m,precipitation_probability,wind_speed_10m,weather_code",
            "temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
            "timezone": "UTC", "forecast_days": 16,
        })
        res.raise_for_status()
        hourly = res.json().get("hourly") or {}
    except (requests.RequestException, ValueError) as err:
        print(f"warn: weather unavailable: {err}", file=sys.stderr)
        return {"roof": venue["roof"], "venue": venue["name"], "forecast": None}

    target = kickoff.strftime("%Y-%m-%dT%H:00")
    times = hourly.get("time") or []
    if target not in times:
        return {"roof": venue["roof"], "venue": venue["name"], "forecast": None}
    i = times.index(target)
    return {
        "roof": venue["roof"], "venue": venue["name"],
        "forecast": {
            "temperature_f": pick(hourly.get("temperature_2m"), i),
            "precipitation_pct": pick(hourly.get("precipitation_probability"), i),
            "wind_mph": pick(hourly.get("wind_speed_10m"), i),
            "code": pick(hourly.get("weather_code"), i),
        },
    }


def previews(game: dict, team: str, opponent: str, limit: int = 6) -> list[dict]:
    """Articles already collected that are about this specific game.

    Selected by naming the opponent, not by looking for the word "preview": a beat writer's
    piece on the matchup rarely calls itself one, and a keyword list would miss the good ones
    while catching every roundup that happens to use the word."""
    try:
        feed = json.loads(FEED_FILE.read_text())
    except (OSError, ValueError):
        return []

    names = opponent_names(game, opponent)
    if not names:
        return []

    out = []
    for item in feed.get("items") or []:
        if item.get("type") != "article" or team not in (item.get("scopes") or []):
            continue
        title = (item.get("title") or "").lower()
        if not any(name in title for name in names):
            continue
        out.append({
            "title": item.get("title"),
            "url": item.get("url"),
            "source_id": item.get("source_id"),
            "published_at": item.get("published_at"),
        })
    # Newest first, and only a handful: this is the shelf beside the game, not a reading list.
    out.sort(key=lambda a: a.get("published_at") or "", reverse=True)
    return out[:limit]


def opponent_names(game: dict, opponent: str) -> list[str]:
    """Every way a headline might name the other team — nickname, city, abbreviation."""
    side = game["home"] if game["home"]["abbr"] == opponent else game["away"]
    full = (side.get("full") or "").lower()
    nickname = (side.get("name") or "").lower()
    # "Baltimore Ravens" minus "Ravens" leaves the city, which is how half of headlines say it.
    city = full[: -len(nickname)].strip() if nickname and full.endswith(nickname) else ""
    return [n for n in {nickname, city} if len(n) > 3]


def beat_writer(abbr: str) -> dict | None:
    """Who to read for this opponent. The tweets themselves are fetched by the app from the
    Worker, which polls this handle under the `opponent` scope for exactly the week it is
    relevant."""
    try:
        import yaml
        cfg = yaml.safe_load((REPO_ROOT / "config" / "sources.yaml").read_text())
    except Exception:  # noqa: BLE001
        return None
    writer = (cfg.get("team_beat_writers") or {}).get(abbr)
    if not writer or not writer.get("handle"):
        return None
    return {"handle": writer["handle"], "name": writer.get("name") or writer["handle"]}


def espn(path: str, params: dict) -> dict:
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
    print(f"warn: {path}: {last}", file=sys.stderr)
    return {}


def pick(series, i):
    try:
        return series[i]
    except (TypeError, IndexError):
        return None


def parse_iso(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write(path: str, payload: dict) -> None:
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    raise SystemExit(main())
