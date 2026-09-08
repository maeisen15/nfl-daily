#!/usr/bin/env python3
"""Download each news source's own icon into web/icons/sources/<source_id>.png.

The articles list identifies a story by its publisher's mark rather than its name, because a
logo is recognisable in a glance where "NYT Athletic — Ravens" has to be read. Icons are stored
locally rather than hotlinked: it keeps the list working offline, costs no third-party request
per row, and means a publisher redesigning their site can't blank the tab.

Run after adding or changing a news source:

    python3 scripts/fetch_source_icons.py

A source whose icon this picks up wrongly gets an `icon_url:` in config/sources.yaml, which
wins over anything found on the page.
"""

from __future__ import annotations

import io
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
import yaml
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config" / "sources.yaml"
OUT_DIR = ROOT / "web" / "icons" / "sources"
SIZE = 96
TIMEOUT = 12
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
}

# Ranked by how likely each is to be the publisher's real mark at a usable resolution. Touch
# icons are designed to be seen at this size; a favicon.ico is the last resort.
ICON_RELS = [
    ("apple-touch-icon-precomposed", 400),
    ("apple-touch-icon", 300),
    ("shortcut icon", 100),
    ("icon", 100),
    ("mask-icon", 10),
]


def main() -> int:
    config = yaml.safe_load(CONFIG.read_text())
    sources = collect_sources(config)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"{len(sources)} sources → {OUT_DIR.relative_to(ROOT)}")
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda s: (s["id"], fetch_icon(s)), sources))

    ok = [sid for sid, path in results if path]
    for sid, path in results:
        print(f"  {'ok  ' if path else 'MISS'} {sid}")
    print(f"\n{len(ok)}/{len(results)} icons written")
    missing = [sid for sid, path in results if not path]
    if missing:
        print("Add an icon_url: in config/sources.yaml for: " + ", ".join(missing))
    return 0


def collect_sources(config: dict) -> list[dict]:
    """Every source whose items land in the Articles tab, in config order."""
    out: list[dict] = []
    seen: set[str] = set()

    def add(entries):
        for entry in entries or []:
            if not entry.get("enabled", True):
                continue
            sid = entry.get("id")
            if not sid or sid in seen:
                continue
            seen.add(sid)
            out.append(entry)

    add(config.get("news_sources"))
    add(config.get("analysis_sources"))
    team = config.get("team_coverage") or {}
    add((team.get("primary") or {}).get("news_sources"))
    for rival in team.get("rivals") or []:
        add(rival.get("news_sources"))
    return out


def fetch_icon(source: dict) -> Path | None:
    site = source.get("url") or source.get("rss_url") or ""
    if not site:
        return None
    try:
        candidates = []
        override = source.get("icon_url")
        if override:
            candidates = [override]
        else:
            candidates = discover(site)
        for url in candidates:
            image = download_image(url)
            if image is not None:
                return save(source["id"], image)
    except Exception:
        # A publisher that blocks us, or serves an icon we can't decode. The app falls back to
        # a lettered badge, so a miss degrades rather than breaks.
        return None
    return None


def discover(site: str) -> list[str]:
    """Icon URLs declared by the page, best first, then the conventional fallbacks."""
    urls: list[tuple[int, str]] = []
    try:
        res = requests.get(site, headers=HEADERS, timeout=TIMEOUT)
        if res.ok and "html" in res.headers.get("content-type", ""):
            html = res.text[:400_000]
            for tag in re.findall(r"<link\b[^>]*>", html, re.I):
                rel = attr(tag, "rel")
                href = attr(tag, "href")
                if not rel or not href:
                    continue
                rel = rel.strip().lower()
                score = next((s for name, s in ICON_RELS if name == rel), 0)
                if not score:
                    continue
                # A declared size is the tiebreaker: a 180px touch icon beats a 32px one.
                sizes = attr(tag, "sizes") or ""
                match = re.match(r"(\d+)", sizes)
                if match:
                    score += min(int(match.group(1)), 512) // 8
                urls.append((score, urljoin(res.url, href)))
    except requests.RequestException:
        pass

    urls.sort(key=lambda pair: pair[0], reverse=True)
    ordered = [url for _, url in urls]

    root = f"{urlparse(site).scheme}://{urlparse(site).netloc}"
    for fallback in ("/apple-touch-icon.png", "/favicon.ico"):
        candidate = root + fallback
        if candidate not in ordered:
            ordered.append(candidate)
    return ordered


def attr(tag: str, name: str) -> str | None:
    match = re.search(rf'{name}\s*=\s*"([^"]*)"', tag, re.I) or \
            re.search(rf"{name}\s*=\s*'([^']*)'", tag, re.I)
    return match.group(1) if match else None


def download_image(url: str) -> Image.Image | None:
    if not url.startswith(("http://", "https://")):
        return None
    res = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
    if not res.ok or len(res.content) < 100:
        return None
    try:
        image = Image.open(io.BytesIO(res.content))
        image.load()
    except Exception:
        return None
    # A multi-resolution .ico needs no special handling: Pillow opens the largest frame.
    # Anything this small is a spacer or a legacy 16px favicon that would look like mush.
    if min(image.size) < 32:
        return None
    return image


def save(source_id: str, image: Image.Image) -> Path:
    image = image.convert("RGBA")
    # Flatten onto white: many marks are dark artwork on transparency, which vanishes in the
    # app's dark themes. A white tile is what a publisher's icon sits on everywhere else.
    canvas = Image.new("RGBA", image.size, (255, 255, 255, 255))
    canvas.alpha_composite(image)
    canvas = canvas.convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)
    path = OUT_DIR / f"{source_id}.png"
    canvas.save(path, "PNG", optimize=True)
    return path


if __name__ == "__main__":
    raise SystemExit(main())
