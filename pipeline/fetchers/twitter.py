"""Twitter fetcher.

Two interchangeable backends — chosen by `twitter_path` at the top of sources.yaml:

  - "rsshub":         GET <twitter_endpoint>/twitter/user/<handle> → RSS XML.
                      Default v1 path; runs from a local Docker container at
                      http://localhost:1200 (diygod/rsshub).
  - "twitterapi_io":  GET https://api.twitterapi.io/twitter/user/last_tweets?userName=<handle>
                      → JSON. Falls back to this only if rsshub fails the reliability test.
                      Requires TWITTERAPI_IO_KEY in ~/.nfl-digest/secrets.env.
  - "disabled":       Skip the source entirely (warn, 0 items).

Per-source config in `twitter_news_handles` / `twitter_analysis_handles`:
  - handle (string, no @ prefix)
  - name (human display name)
  - enabled (bool)

Top-level config at sources.yaml root:
  - twitter_path (string, see above)
  - twitter_endpoint (string, base URL for rsshub)
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import feedparser
import requests

DEFAULT_TIMEOUT = 15
DEFAULT_UA = "Mozilla/5.0"
SECRETS_FILE = Path(os.path.expanduser(
    os.environ.get("NFL_DAILY_SECRETS", "~/.nfl-digest/secrets.env")))

# twitterapi.io free tier rate-limits aggressive parallel access (HTTP 429 with 8 concurrent
# requests). Serialize calls with a global lock and a min-interval gate so all 9 handles run
# back-to-back at a polite cadence even when the orchestrator dispatches them in parallel.
import threading
_TWITTERAPI_LOCK = threading.Lock()
_TWITTERAPI_LAST_CALL = [0.0]  # mutable container so the inner closure can mutate
_TWITTERAPI_MIN_INTERVAL_S = 2.0


def fetch(source: dict[str, Any]) -> dict[str, Any]:
    """Fetch one Twitter handle. `source` carries:
        - id (e.g. 'twitter_news_AdamSchefter')
        - handle
        - twitter_path / twitter_endpoint (resolved by orchestrator)
        - tier ("twitter_news_handles" or "twitter_analysis_handles") — informational
    """
    source_id = source["id"]
    handle = source["handle"]
    path = (source.get("twitter_path") or "rsshub").lower()
    endpoint = source.get("twitter_endpoint") or "http://localhost:1200"
    max_items = source.get("max_items", 30)
    started = time.monotonic()

    if path == "disabled":
        return _result(
            source_id,
            "warn",
            [],
            int((time.monotonic() - started) * 1000),
            "twitter_path is 'disabled' in sources.yaml",
        )

    try:
        if path == "rsshub":
            items = _fetch_rsshub(endpoint, handle, source_id, max_items)
        elif path == "twitterapi_io":
            items = _fetch_twitterapi_io(handle, source_id, max_items)
        else:
            return _result(
                source_id,
                "error",
                [],
                int((time.monotonic() - started) * 1000),
                f"unknown twitter_path: {path!r}",
            )

        if not items:
            return _result(
                source_id,
                "warn",
                items,
                int((time.monotonic() - started) * 1000),
                f"{path}: 0 tweets returned",
            )
        return _result(source_id, "ok", items, int((time.monotonic() - started) * 1000), None)
    except Exception as exc:  # noqa: BLE001
        return _result(
            source_id,
            "error",
            [],
            int((time.monotonic() - started) * 1000),
            f"{type(exc).__name__}: {exc}",
        )


def _fetch_rsshub(endpoint: str, handle: str, source_id: str, max_items: int) -> list[dict[str, Any]]:
    url = f"{endpoint.rstrip('/')}/twitter/user/{handle}"
    resp = requests.get(
        url,
        timeout=DEFAULT_TIMEOUT,
        headers={"User-Agent": DEFAULT_UA, "Accept": "application/rss+xml, application/xml, text/xml"},
    )
    resp.raise_for_status()
    parsed = feedparser.parse(resp.content)
    items: list[dict[str, Any]] = []
    for entry in parsed.entries[:max_items]:
        items.append(_normalize_rss_entry(source_id, handle, entry))
    return items


def _fetch_twitterapi_io(handle: str, source_id: str, max_items: int) -> list[dict[str, Any]]:
    api_key = _load_secret("TWITTERAPI_IO_KEY")
    if not api_key:
        raise RuntimeError("TWITTERAPI_IO_KEY missing in ~/.nfl-digest/secrets.env")
    # Serialize calls + min-interval + one retry on 429. twitterapi.io's rate limit isn't
    # documented precisely but a 2s floor + retry handles 9 parallel handles reliably.
    def _do_request() -> requests.Response:
        with _TWITTERAPI_LOCK:
            gap = time.monotonic() - _TWITTERAPI_LAST_CALL[0]
            if gap < _TWITTERAPI_MIN_INTERVAL_S:
                time.sleep(_TWITTERAPI_MIN_INTERVAL_S - gap)
            _TWITTERAPI_LAST_CALL[0] = time.monotonic()
            return requests.get(
                "https://api.twitterapi.io/twitter/user/last_tweets",
                params={"userName": handle},
                headers={"X-API-Key": api_key, "User-Agent": DEFAULT_UA, "Accept": "application/json"},
                timeout=DEFAULT_TIMEOUT,
            )

    resp = _do_request()
    for backoff in (3.0, 6.0, 12.0):
        if resp.status_code != 429:
            break
        time.sleep(backoff)
        resp = _do_request()
    resp.raise_for_status()
    body = resp.json()
    if body.get("status") and body.get("status") != "success":
        raise RuntimeError(f"twitterapi.io: {body.get('msg') or body.get('message') or 'unknown error'}")
    # Actual response shape (May 2026): {status, code, msg, data: {pin_tweet, tweets: [...]}}
    payload = body.get("data") or {}
    tweets = payload.get("tweets") or []
    return [_normalize_twitterapi_tweet(source_id, handle, tw) for tw in tweets[:max_items]]


def _normalize_rss_entry(source_id: str, handle: str, entry: Any) -> dict[str, Any]:
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
    text_full = _strip_html(summary) or title
    return {
        "source_id": source_id,
        "title": _trim(title, 280),
        "text": text_full,
        "tweet_id": _tweet_id_from_url(link),
        "url": link,
        "published_at": pub_iso,
        "snippet": _trim(_strip_html(summary), 300),
        "author": handle,
        "is_retweet": _looks_like_retweet(title) or _looks_like_retweet(text_full),
        "is_reply": _looks_like_reply(title) or _looks_like_reply(text_full),
        "media": [],  # RSSHub path doesn't expose structured media
    }


def _normalize_twitterapi_tweet(source_id: str, handle: str, tw: dict[str, Any]) -> dict[str, Any]:
    text = (tw.get("text") or "").strip()
    canonical_url = (tw.get("url") or "").strip()
    tweet_id = tw.get("id") or ""
    # Prefer twitterapi.io's structured fields; fall back to text heuristic so the values
    # are still meaningful if the API shape changes.
    is_retweet = tw.get("retweeted_tweet") is not None or _looks_like_retweet(text)
    is_reply = (
        bool(tw.get("isReply"))
        or tw.get("inReplyToId") is not None
        or _looks_like_reply(text)
    )
    return {
        "source_id": source_id,
        "title": _trim(text, 280),
        "text": text,
        "tweet_id": str(tweet_id) if tweet_id else "",
        "url": canonical_url or (f"https://twitter.com/{handle}/status/{tweet_id}" if tweet_id else ""),
        "published_at": _twitter_date_to_iso(tw.get("createdAt")),
        "snippet": None,
        "author": handle,
        "is_retweet": is_retweet,
        "is_reply": is_reply,
        "media": _extract_media(tw),
    }


def _extract_media(tw: dict[str, Any]) -> list[dict[str, Any]]:
    """Media from extendedEntities.media[].
    - photo: {type:'photo', url:<image>}
    - video / animated_gif: {type, url:<poster>, video_url:<mp4>, loop:<bool>}
      video_url is a directly playable mp4 on video.twimg.com (iOS WebKit plays it inline).
    """
    out: list[dict[str, Any]] = []
    ee = tw.get("extendedEntities") or tw.get("extended_entities") or {}
    for m in ee.get("media") or []:
        mtype = m.get("type") or "photo"
        poster = m.get("media_url_https") or m.get("media_url") or ""
        item: dict[str, Any] = {"type": mtype, "url": poster}
        if mtype in ("video", "animated_gif"):
            vurl = _pick_mp4_variant(m)
            if not vurl:
                continue  # video with no usable mp4 — skip rather than show a dead poster
            item["video_url"] = vurl
            item["loop"] = mtype == "animated_gif"
        elif not poster:
            continue
        out.append(item)
    return out


def _pick_mp4_variant(media: dict[str, Any]) -> str:
    """Choose the best mp4 variant <=720p (good quality without wasting cellular data),
    falling back to the highest-bitrate mp4 available."""
    vi = media.get("video_info") or media.get("videoInfo") or {}
    variants = [
        v for v in (vi.get("variants") or [])
        if (v.get("content_type") or v.get("contentType")) == "video/mp4" and v.get("url")
    ]
    if not variants:
        return ""
    def bitrate(v: dict[str, Any]) -> int:
        try:
            return int(v.get("bitrate") or 0)
        except (TypeError, ValueError):
            return 0
    capped = [v for v in variants if "/1280x720/" in v["url"] or bitrate(v) <= 2176000]
    pool = capped or variants
    return max(pool, key=bitrate)["url"]


def _looks_like_retweet(text: str) -> bool:
    return (text or "").lstrip().startswith("RT @")


_REPLY_HEURISTIC_RE = None  # lazily compiled


def _looks_like_reply(text: str) -> bool:
    """Reply-style tweet: opens with one or more @handle mentions before any other content.
    Used only as a fallback when structured fields aren't available."""
    global _REPLY_HEURISTIC_RE
    if _REPLY_HEURISTIC_RE is None:
        import re
        _REPLY_HEURISTIC_RE = re.compile(r"^\s*@\w+\s")
    return bool(_REPLY_HEURISTIC_RE.match(text or ""))


def _tweet_id_from_url(url: str) -> str:
    import re
    m = re.search(r"/status/(\d+)", url or "")
    return m.group(1) if m else ""


def _twitter_date_to_iso(value: Any) -> str | None:
    """Twitter's classic createdAt format: 'Sun May 24 14:25:55 +0000 2026'.
    Parse to ISO 8601 so the orchestrator's recency filter accepts it.
    """
    if not value or not isinstance(value, str):
        return None
    from email.utils import parsedate_to_datetime
    try:
        # parsedate_to_datetime handles RFC 2822-ish formats including this one.
        dt = parsedate_to_datetime(value)
        return dt.isoformat()
    except (TypeError, ValueError):
        return None


def _result(source_id: str, status: str, items: list, latency_ms: int, note: str | None) -> dict[str, Any]:
    return {
        "source_id": source_id,
        "status": status,
        "items_fetched": len(items),
        "latency_ms": latency_ms,
        "note": note,
        "items": items,
    }


def _strip_html(text: str) -> str:
    import re

    return re.sub(r"<[^>]+>", " ", text or "")


def _trim(text: str, max_chars: int) -> str:
    import re

    clean = re.sub(r"\s+", " ", text or "").strip()
    return clean if len(clean) <= max_chars else clean[: max_chars - 1].rstrip() + "…"


def _load_secret(key: str) -> str | None:
    # Environment first (cloud agent injects secrets as env vars), file fallback (local Mac).
    if os.environ.get(key):
        return os.environ[key]
    if not SECRETS_FILE.exists():
        return None
    for line in SECRETS_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == key:
            return v.strip().strip("\"'")
    return None
