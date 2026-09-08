"""Generic RSS fetcher. Returns a normalized list of Item dicts."""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

import feedparser
import requests

from . import images

DEFAULT_TIMEOUT = 15
# NOTE: ESPN's Akamai serves HTTP 202 (empty body) to "rich" browser User-Agents because the
# real browser would solve a JS challenge. A minimal "Mozilla/5.0" string is treated as
# non-browser and bypassed cleanly. All four v1 RSS sources (ESPN, CBS, NYT Athletic, FOX)
# verified working with this UA on 2026-05-24.
DEFAULT_UA = "Mozilla/5.0"


def fetch(source: dict[str, Any]) -> dict[str, Any]:
    """Fetch one RSS source.

    `source` is the sources.yaml entry. Expected keys:
      - id (string, unique)
      - name (string, human readable)
      - rss_url (string, the actual feed URL) — falls back to `url` if missing
      - max_items (int, optional, default 50)
      - fetch_og_image (bool, optional, default false) — for feeds that carry no image of their
        own (ESPN's does not), fetch each article page and read its og:image. One extra HTTP
        call per imageless item, run through a bounded pool, so it is opt-in per source.

    Every item carries an `image` key: an absolute https URL, or None. Extraction never raises
    — an article with no image publishes normally.

    Returns a dict with:
      - source_id, status ("ok" | "warn" | "error"), items_fetched, latency_ms, note, items
    """
    source_id = source["id"]
    rss_url = source.get("rss_url") or source.get("url")
    max_items = source.get("max_items", 50)
    started = time.monotonic()
    note: str | None = None
    items: list[dict[str, Any]] = []
    status = "ok"

    try:
        resp = requests.get(
            rss_url,
            timeout=DEFAULT_TIMEOUT,
            headers={"User-Agent": DEFAULT_UA, "Accept": "application/rss+xml, application/xml, text/xml, */*"},
        )
        resp.raise_for_status()
        parsed = feedparser.parse(resp.content)

        if parsed.bozo and not parsed.entries:
            raise RuntimeError(f"feedparser bozo: {parsed.bozo_exception!r}")

        for entry in parsed.entries[:max_items]:
            items.append(_normalize_entry(source_id, entry))

        if items and source.get("fetch_og_image"):
            images.fill_missing_images(items)

        if not items:
            status = "warn"
            note = "feed parsed but no entries"
    except Exception as exc:  # noqa: BLE001 — broad on purpose; report and continue
        status = "error"
        note = f"{type(exc).__name__}: {exc}"

    latency_ms = int((time.monotonic() - started) * 1000)
    return {
        "source_id": source_id,
        "status": status,
        "items_fetched": len(items),
        "latency_ms": latency_ms,
        "note": note,
        "items": items,
    }


def _normalize_entry(source_id: str, entry: Any) -> dict[str, Any]:
    title = (getattr(entry, "title", "") or "").strip()
    link = (getattr(entry, "link", "") or "").strip()
    summary = (getattr(entry, "summary", "") or getattr(entry, "description", "") or "").strip()

    pub_iso: str | None = None
    for attr in ("published_parsed", "updated_parsed"):
        st = getattr(entry, attr, None)
        if st:
            try:
                pub_iso = datetime(*st[:6], tzinfo=timezone.utc).isoformat()
                break
            except (TypeError, ValueError):
                continue

    author = (getattr(entry, "author", "") or "").strip() or None

    return {
        "source_id": source_id,
        "title": title,
        "url": link,
        "published_at": pub_iso,
        "snippet": _trim_snippet(summary),
        "author": author,
        "image": _extract_image(entry, link),
    }


def _extract_image(entry: Any, base: str) -> str | None:
    """Best-effort article image from the feed entry itself — no extra HTTP request.

    Order of preference: media:content (largest), media:thumbnail, an image enclosure, then
    the first usable <img> in the entry's content or summary HTML. Returns None if the entry
    carries nothing usable; an article with no image still publishes normally.
    """
    try:
        # media:content — may carry several renditions; take the largest that qualifies.
        best: tuple[int, str] | None = None
        for mc in getattr(entry, "media_content", None) or []:
            if not isinstance(mc, dict):
                continue
            medium = (mc.get("medium") or "").lower()
            mime = (mc.get("type") or "").lower()
            if mime and not mime.startswith("image/"):
                continue
            if medium and medium != "image":
                continue
            if not images.dimensions_ok(mc.get("width"), mc.get("height")):
                continue
            url = images.clean_image_url(mc.get("url"), base)
            if not url:
                continue
            size = images.area(mc.get("width"), mc.get("height"))
            if best is None or size > best[0]:
                best = (size, url)
        if best:
            return best[1]

        for mt in getattr(entry, "media_thumbnail", None) or []:
            if not isinstance(mt, dict):
                continue
            if not images.dimensions_ok(mt.get("width"), mt.get("height")):
                continue
            url = images.clean_image_url(mt.get("url"), base)
            if url:
                return url

        # <enclosure url="..." type="image/jpeg"> — feedparser exposes these twice.
        for enc in (getattr(entry, "enclosures", None) or []) + (getattr(entry, "links", None) or []):
            if not isinstance(enc, dict):
                continue
            mime = (enc.get("type") or "").lower()
            rel = (enc.get("rel") or "").lower()
            if not mime.startswith("image/"):
                continue
            if rel and rel not in ("enclosure", "image"):
                continue
            url = images.clean_image_url(enc.get("href") or enc.get("url"), base)
            if url:
                return url

        # Inline <img> in the entry body.
        fragments = [c.get("value") for c in (getattr(entry, "content", None) or [])
                     if isinstance(c, dict)]
        fragments += [getattr(entry, "summary", "") or "", getattr(entry, "description", "") or ""]
        for fragment in fragments:
            url = images.image_from_html(fragment or "", base)
            if url:
                return url
    except Exception:  # noqa: BLE001 — image extraction must never break an article
        return None
    return None


def _trim_snippet(text: str, max_chars: int = 250) -> str:
    """Strip HTML tags and trim. Cheap regex-based clean — good enough for pre-truncation."""
    import re

    clean = re.sub(r"<[^>]+>", " ", text)
    clean = re.sub(r"\s+", " ", clean).strip()
    if len(clean) > max_chars:
        clean = clean[: max_chars - 1].rstrip() + "…"
    return clean
