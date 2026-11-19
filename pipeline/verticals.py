"""The verticals that are a flat list of sources.

Football is built from config/sources.yaml and has teams, rivals and a season, so it is not
described here. Every other vertical is the same simple shape — one scope, a list of Twitter
handles, a list of article feeds — and this is the one place that says which ones exist. The
handle sync, the article fetch, the icon fetch and the app's config.json all read it, so adding
a vertical is one entry below plus its config/sources.<code>.yaml.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent

# `tabs` is the bottom bar, in order; the first one is where the vertical opens. Tweets leads
# wherever a vertical has handles, because the feed is the product.
FLAT: list[dict[str, Any]] = [
    {
        "code": "politics",
        "label": "Politics",
        "scope": {"code": "elections", "label": "Elections"},
        # No schedule: there is no season to page through.
        "tabs": ["tweets", "articles", "brief"],
    },
    {
        "code": "ai",
        "label": "AI",
        "scope": {"code": "ai", "label": "AI"},
        "tabs": ["tweets", "articles"],
    },
]


def sources_file(vertical: dict[str, Any]) -> Path:
    return REPO_ROOT / "config" / f"sources.{vertical['code']}.yaml"


def load_sources(vertical: dict[str, Any]) -> dict[str, Any]:
    path = sources_file(vertical)
    if not path.exists():
        return {}
    with path.open() as f:
        return yaml.safe_load(f) or {}


def handles(vertical: dict[str, Any]) -> list[dict[str, Any]]:
    """Enabled Twitter handles, as written in the vertical's sources file."""
    return [tw for tw in load_sources(vertical).get("twitter_handles") or []
            if tw.get("enabled", True)]


def news_sources(vertical: dict[str, Any]) -> list[dict[str, Any]]:
    """Enabled article feeds, as written in the vertical's sources file."""
    return [s for s in load_sources(vertical).get("news_sources") or []
            if s.get("enabled", True)]


def data_dir(vertical: dict[str, Any]) -> str:
    """Where the vertical's feed.json lives, relative to web/."""
    return f"data/{vertical['code']}"


def config_entries() -> list[dict[str, Any]]:
    """Each flat vertical as the app's config.json describes it.

    A vertical with no enabled handles has nothing to poll, so it neither asks the Worker for
    tweets nor shows a Tweets tab: an always-empty feed as the opening screen reads as broken.
    The tab appears by itself once the sources file carries a handle.
    """
    out = []
    for v in FLAT:
        live = bool(handles(v))
        scope = v["scope"]
        out.append({
            "code": v["code"],
            "label": v["label"],
            "data_dir": data_dir(v),
            "default_scope": scope["code"],
            "tabs": [t for t in v["tabs"] if live or t != "tweets"],
            "live_tweets": live,
            "scopes": [{"code": scope["code"], "label": scope["label"],
                        "short": scope["label"], "role": "primary"}],
        })
    return out
