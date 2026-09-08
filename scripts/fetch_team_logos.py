#!/usr/bin/env python3
"""Download all 32 NFL team logos into web/icons/teams/<ABBR>.png.

The schedule tab is a wall of matchups, and a logo is read at a glance where an abbreviation
has to be decoded. Stored locally rather than hotlinked for the same reasons the publisher
icons are: it works offline, costs no third-party request per row, and cannot be broken by
someone else's redesign.

    python3 scripts/fetch_team_logos.py

Run once; team logos change about as often as team names.
"""

from __future__ import annotations

import io
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "web" / "icons" / "teams"
SIZE = 96
TIMEOUT = 15
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                         "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"}

TEAMS = ["ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN", "DET", "GB",
         "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA", "MIN", "NE", "NO", "NYG",
         "NYJ", "PHI", "PIT", "SEA", "SF", "TB", "TEN", "WSH"]

# 500px transparent PNGs. The /scoreboard/ variant is the same mark with a dark-background
# treatment, which is wrong for a light theme.
URL = "https://a.espncdn.com/i/teamlogos/nfl/500/{slug}.png"


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(fetch, TEAMS))
    ok = [t for t, path in results if path]
    for team, path in results:
        if not path:
            print(f"  MISS {team}")
    print(f"{len(ok)}/{len(results)} team logos written to {OUT_DIR.relative_to(ROOT)}")
    return 0 if len(ok) == len(results) else 1


def fetch(team: str) -> tuple[str, Path | None]:
    try:
        res = requests.get(URL.format(slug=team.lower()), headers=HEADERS, timeout=TIMEOUT)
        if not res.ok:
            return team, None
        image = Image.open(io.BytesIO(res.content))
        image.load()
    except Exception:
        return team, None
    return team, save(team, image)


def save(team: str, image: Image.Image) -> Path:
    image = image.convert("RGBA")
    # Fitted into a square rather than stretched: several marks are much wider than they are
    # tall, and a resize to a square would squash them into something unrecognisable.
    image.thumbnail((SIZE, SIZE), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(image, ((SIZE - image.width) // 2, (SIZE - image.height) // 2))
    path = OUT_DIR / f"{team}.png"
    # Transparent, unlike the publisher icons: a team mark sits on the page background, and
    # these are colourful enough to read on light and dark alike.
    canvas.save(path, "PNG", optimize=True)
    return path


if __name__ == "__main__":
    raise SystemExit(main())
