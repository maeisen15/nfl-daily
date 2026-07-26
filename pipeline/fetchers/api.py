"""Generic JSON API fetcher with response-shape mapping config.

`source` config keys:
  - id, name
  - api_url (string) — full URL with any query params
  - items_path (string, dotted path) — where the item list lives, e.g. "items" or "injuries"
  - field_map (dict) — maps Item field -> dotted path into each API item
        e.g. {"title": "description", "url": "team.$ref", "published_at": "date"}
  - max_items (int, default 200)
  - timeout (int, default 15)

The api fetcher is intentionally dumb — it pulls JSON, walks `items_path`, and projects
each entry through `field_map`. Source-specific shaping happens in sources.yaml so we can
add new APIs without writing new Python.
"""
from __future__ import annotations

import time
from typing import Any

import requests

DEFAULT_TIMEOUT = 15
DEFAULT_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120 Safari/537.36"
)


def fetch(source: dict[str, Any]) -> dict[str, Any]:
    source_id = source["id"]
    api_url = source["api_url"]
    items_path = source.get("items_path", "items")
    field_map = source.get("field_map", {})
    max_items = source.get("max_items", 200)
    timeout = source.get("timeout", DEFAULT_TIMEOUT)
    started = time.monotonic()
    note: str | None = None
    items: list[dict[str, Any]] = []
    status = "ok"

    try:
        resp = requests.get(
            api_url,
            timeout=timeout,
            headers={"User-Agent": DEFAULT_UA, "Accept": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()
        raw_items = _walk(data, items_path)
        if raw_items is None:
            raise RuntimeError(f"items_path '{items_path}' did not resolve")
        if not isinstance(raw_items, list):
            raise RuntimeError(f"items_path '{items_path}' resolved to {type(raw_items).__name__}, expected list")

        for raw in raw_items[:max_items]:
            items.append(_project(source_id, raw, field_map))

        if not items:
            status = "warn"
            note = "endpoint returned zero items"
    except Exception as exc:  # noqa: BLE001
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


def _walk(data: Any, dotted: str) -> Any:
    """Walk a dotted path through nested dicts. Empty string returns data itself."""
    if not dotted:
        return data
    cur = data
    for part in dotted.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
        if cur is None:
            return None
    return cur


def _project(source_id: str, raw: dict[str, Any], field_map: dict[str, str]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "source_id": source_id,
        "title": None,
        "url": None,
        "published_at": None,
        "snippet": None,
        "author": None,
    }
    for field, path in field_map.items():
        out[field] = _walk(raw, path)
    return out
