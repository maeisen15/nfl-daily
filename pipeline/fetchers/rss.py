"""Generic RSS fetcher. Returns a normalized list of Item dicts."""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

import feedparser
import requests

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
    }


def _trim_snippet(text: str, max_chars: int = 250) -> str:
    """Strip HTML tags and trim. Cheap regex-based clean — good enough for pre-truncation."""
    import re

    clean = re.sub(r"<[^>]+>", " ", text)
    clean = re.sub(r"\s+", " ", clean).strip()
    if len(clean) > max_chars:
        clean = clean[: max_chars - 1].rstrip() + "…"
    return clean
