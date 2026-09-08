"""Generic HTML-scrape fetcher.

Per-source config in sources.yaml drives the extraction. Keys:
  - id, name
  - url (string, the page to fetch)
  - item_selector (string, CSS selector or attribute pattern) — see HARVEST modes below
  - link_pattern (string, regex used in 'href_regex' mode) — matches href values; group(0) is the
    relative URL, fallback to the full href if no groups defined
  - link_base (string, URL prefix prepended to relative links if they start with '/')
  - title_strategy (string, default 'anchor_text') — anchor_text | parent_text | attribute:<name>
  - dedupe (bool, default true) — drop duplicate URLs
  - max_items (int, default 50)
  - date_strategy (string, optional) — controls where to extract `published_at`:
        "url_yyyy_mm_dd"  Pull date from URL path matching /<YYYY>/<MM>/<DD>/. Used by Ringer.
        "title_suffix_month_day"  Pull trailing "Month DD" from anchor text. Used by NFL.com.
                                  Year is inferred as current year (or prior year if the parsed
                                  date would be in the future).
        "article_meta"    Follow each article URL and parse <meta property="article:published_time">
                          or JSON-LD datePublished. Slower (one HTTP call per item) but reliable
                          for sites that don't expose dates on the index page or in URLs. Items
                          whose article fetch fails keep published_at=None and get dropped by
                          the orchestrator's strict recency filter.
        (omit)            No date extraction; published_at stays None.
  - fetch_og_image (bool, default false) — opt in to fetching each article page purely to read
        its og:image. Only needed for sources that do NOT already use date_strategy:
        article_meta (those get the image out of the same request for free). Costs one HTTP
        call per item that the index page didn't already yield an image for, run through the
        same bounded thread pool. Leave it off for sources where latency matters more than
        thumbnails.

IMAGES: every item gets an `image` key (an absolute https URL, or None). The index page's own
markup is checked first because it is free; the article page is only fetched when it is being
fetched anyway for the date, or when fetch_og_image is set. Extraction never raises — an
article with no image publishes normally.

HARVEST MODES (driven by which selector key is set):

  href_regex MODE (use link_pattern):
    Walk all <a href="..."> in the document and keep links whose href matches link_pattern.
    Title comes from anchor text (or per title_strategy). Cheap and robust for sites whose
    article URLs follow a clear convention (e.g. /news/<slug>, /<year>/<month>/<day>/<topic>/).
    Use this for NFL.com news and The Ringer NFL.

  css MODE (use css_selector):
    Use a CSS selector to find item containers; pull title + href from inside each container.
    Use for more structured pages where you want to control title extraction precisely.

The scraper does NOT attempt to extract publication dates or rich snippets from index pages —
that's a separate enrichment step (out of scope for v1). Items returned will have
`published_at: None` and `snippet: None` from this fetcher.
"""
from __future__ import annotations

import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

from . import images

DEFAULT_TIMEOUT = 15
DEFAULT_UA = "Mozilla/5.0"
# Article-meta enrichment uses a fuller browser-like UA since some publishers reject bare UAs
# on per-article pages even though their topic pages accept them.
ARTICLE_META_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
ARTICLE_META_WORKERS = 5
# (connect, read). A publisher that never completes the handshake fails in 5s instead of
# holding a worker for the full read budget and stretching the hourly run.
ARTICLE_META_TIMEOUT = (5, 10)


def fetch(source: dict[str, Any]) -> dict[str, Any]:
    source_id = source["id"]
    url = source["url"]
    max_items = source.get("max_items", 50)
    started = time.monotonic()
    note: str | None = None
    items: list[dict[str, Any]] = []
    status = "ok"

    try:
        resp = requests.get(
            url,
            timeout=DEFAULT_TIMEOUT,
            headers={"User-Agent": DEFAULT_UA, "Accept": "text/html, */*"},
        )
        resp.raise_for_status()
        soup = BeautifulSoup(resp.content, "html.parser")

        if "link_pattern" in source:
            items = _harvest_href_regex(soup, source, max_items)
        elif "css_selector" in source:
            items = _harvest_css(soup, source, max_items)
        else:
            raise RuntimeError("source must define either 'link_pattern' or 'css_selector'")

        for it in items:
            it["source_id"] = source_id

        want_date = source.get("date_strategy") == "article_meta"
        want_image = bool(source.get("fetch_og_image"))
        if items and (want_date or want_image):
            _enrich_from_article_page(items, want_date=want_date, want_image=want_image)

        # `assume_current`: for status pages that carry no per-item date (NFL.com
        # injuries/transactions), treat undated items as current so the strict recency filter
        # doesn't silently drop every one of them. These pages only ever show current-week
        # state, so "now" is accurate. NOTE: their titles are bare player names with no team,
        # so downstream team-tagging can't route them to a team tab (national only). Verify in
        # preseason once the pages actually populate.
        if source.get("assume_current"):
            from datetime import datetime, timezone
            now_iso = datetime.now(timezone.utc).isoformat()
            for it in items:
                if not it.get("published_at"):
                    it["published_at"] = now_iso

        if not items:
            status = "warn"
            note = "page fetched but no items matched selector"
        elif source.get("date_strategy") == "article_meta":
            dated = sum(1 for it in items if it.get("published_at"))
            if dated == 0:
                status = "warn"
                note = f"{len(items)} items found but all article_meta fetches failed to extract a date"
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


def _harvest_href_regex(soup: BeautifulSoup, source: dict[str, Any], max_items: int) -> list[dict[str, Any]]:
    pattern = re.compile(source["link_pattern"])
    base = source.get("link_base", "")
    dedupe = source.get("dedupe", True)
    title_strategy = source.get("title_strategy", "anchor_text")
    seen: set[str] = set()
    items: list[dict[str, Any]] = []

    date_strategy = source.get("date_strategy")
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if not pattern.search(href):
            continue
        url = _absolutize(href, base)
        if dedupe and url in seen:
            continue
        title = _extract_title(a, title_strategy)
        if not title:
            continue  # skip empty-anchor decorations (image-only links etc.)
        seen.add(url)
        clean_title, pub_iso = _maybe_extract_date(title, url, date_strategy)
        items.append(
            {
                "source_id": None,  # filled by caller
                "title": clean_title,
                "url": url,
                "published_at": pub_iso,
                "snippet": None,
                "author": None,
                "image": _image_near_anchor(a, source.get("url", "")),
            }
        )
        if len(items) >= max_items:
            break
    return items


def _harvest_css(soup: BeautifulSoup, source: dict[str, Any], max_items: int) -> list[dict[str, Any]]:
    selector = source["css_selector"]
    base = source.get("link_base", "")
    dedupe = source.get("dedupe", True)
    title_strategy = source.get("title_strategy", "anchor_text")
    seen: set[str] = set()
    items: list[dict[str, Any]] = []

    for node in soup.select(selector):
        a = node if node.name == "a" else node.find("a", href=True)
        if not a or not a.get("href"):
            continue
        url = _absolutize(a["href"], base)
        if dedupe and url in seen:
            continue
        title = _extract_title(a, title_strategy)
        if not title:
            continue
        seen.add(url)
        items.append(
            {
                "source_id": None,
                "title": title,
                "url": url,
                "published_at": None,
                "snippet": None,
                "author": None,
                "image": _image_near_anchor(node, source.get("url", "")),
            }
        )
        if len(items) >= max_items:
            break
    return items


# How far up the DOM to look for an article thumbnail. An index page's card is usually the
# anchor's parent or grandparent; going further reaches the list container and starts picking
# up other articles' images.
_IMAGE_ANCESTOR_LEVELS = 2
# An ancestor holding more than this many links isn't a single article card any more.
_IMAGE_ANCESTOR_MAX_LINKS = 4


def _image_near_anchor(a, base: str) -> str | None:
    """Best-effort thumbnail from the index page's own markup. Free — no extra request."""
    try:
        node = a
        for level in range(_IMAGE_ANCESTOR_LEVELS + 1):
            if node is None:
                break
            if level > 0 and len(node.find_all("a", href=True)) > _IMAGE_ANCESTOR_MAX_LINKS:
                break
            for img in node.find_all("img"):
                url = images.image_from_img_tag(img, base)
                if url and not images.looks_decorative(url):
                    return url
            node = node.parent
    except Exception:  # noqa: BLE001 — never let image extraction break a source
        return None
    return None


def _extract_title(a, strategy: str) -> str:
    if strategy.startswith("attribute:"):
        attr = strategy.split(":", 1)[1]
        return (a.get(attr) or "").strip()
    if strategy == "parent_text":
        parent = a.parent
        if parent:
            return _clean_text(parent.get_text(" ", strip=True))
    # default: anchor text
    text = _clean_text(a.get_text(" ", strip=True))
    if text:
        return text
    # fall back to aria-label / title attr
    for fallback in ("aria-label", "title"):
        v = (a.get(fallback) or "").strip()
        if v:
            return v
    return ""


def _clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _absolutize(href: str, base: str) -> str:
    if href.startswith(("http://", "https://")):
        return href
    if base:
        return urljoin(base.rstrip("/") + "/", href.lstrip("/"))
    return href


# Map month names → numeric month for the title_suffix_month_day strategy.
_MONTHS = {
    "Jan": 1, "January": 1, "Feb": 2, "February": 2, "Mar": 3, "March": 3,
    "Apr": 4, "April": 4, "May": 5, "Jun": 6, "June": 6, "Jul": 7, "July": 7,
    "Aug": 8, "August": 8, "Sep": 9, "Sept": 9, "September": 9, "Oct": 10, "October": 10,
    "Nov": 11, "November": 11, "Dec": 12, "December": 12,
}

# Trailing "Month DD" or "Month DD, YYYY" at end of title — used by NFL.com news anchors.
_TRAILING_DATE_RE = re.compile(
    r"\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+(\d{1,2})(?:,\s*(\d{4}))?$",
    re.IGNORECASE,
)

# Date prefix in URL path: /YYYY/MM/DD/...
_URL_DATE_RE = re.compile(r"/(20\d{2})/(\d{2})/(\d{2})/")


def _maybe_extract_date(title: str, url: str, strategy: str | None) -> tuple[str, str | None]:
    """Return (cleaned_title, iso_date_or_None). Title is stripped of any trailing date label."""
    if not strategy:
        return title, None

    if strategy == "url_yyyy_mm_dd":
        m = _URL_DATE_RE.search(url)
        if not m:
            return title, None
        try:
            from datetime import date, timezone, datetime
            yyyy, mm, dd = int(m.group(1)), int(m.group(2)), int(m.group(3))
            iso = datetime(yyyy, mm, dd, tzinfo=timezone.utc).isoformat()
            return title, iso
        except (ValueError, OverflowError):
            return title, None

    if strategy == "article_meta":
        # Date is extracted in a separate post-processing pass; nothing to do here.
        return title, None

    if strategy == "title_suffix_month_day":
        m = _TRAILING_DATE_RE.search(title)
        if not m:
            return title, None
        from datetime import date, datetime, timezone
        month = _MONTHS.get(m.group(1).title()) or _MONTHS.get(m.group(1).capitalize())
        if not month:
            return title, None
        day = int(m.group(2))
        clean_title = title[: m.start()].rstrip().rstrip(",")
        # If the regex captured a YYYY, use it directly.
        if m.group(3):
            try:
                iso = datetime(int(m.group(3)), month, day, tzinfo=timezone.utc).isoformat()
                return clean_title, iso
            except ValueError:
                return clean_title, None
        # Otherwise pick the most recent year that places the date <= today.
        today = date.today()
        for year in (today.year, today.year - 1):
            try:
                candidate = date(year, month, day)
            except ValueError:
                continue
            if candidate <= today:
                iso = datetime(year, month, day, tzinfo=timezone.utc).isoformat()
                return clean_title, iso
        try:
            iso = datetime(today.year, month, day, tzinfo=timezone.utc).isoformat()
            return clean_title, iso
        except ValueError:
            return clean_title, None

    return title, None


# ---- article_meta enrichment ------------------------------------------------------------

# Date meta patterns, in priority order. The first match wins.
_ARTICLE_DATE_PATTERNS = [
    re.compile(r'<meta[^>]+property=["\']article:published_time["\'][^>]+content=["\']([^"\']+)', re.I),
    re.compile(r'<meta[^>]+name=["\']pubdate["\'][^>]+content=["\']([^"\']+)', re.I),
    re.compile(r'<meta[^>]+name=["\']publish-date["\'][^>]+content=["\']([^"\']+)', re.I),
    re.compile(r'<meta[^>]+name=["\']publishedDate["\'][^>]+content=["\']([^"\']+)', re.I),
    re.compile(r'"datePublished"\s*:\s*"([^"]+)"', re.I),
    re.compile(r'<meta[^>]+property=["\']article:modified_time["\'][^>]+content=["\']([^"\']+)', re.I),
]


def _enrich_from_article_page(
    items: list[dict[str, Any]], want_date: bool, want_image: bool
) -> None:
    """GET each article URL once and pull the publication date and/or og:image out of it.

    One request per item, at most — date and image come from the same response. Items that
    already have everything the caller wants are skipped, so `fetch_og_image` on a source
    whose index page already carries thumbnails costs nothing.

    Mutates items in place. Failures are silent: `published_at` stays None (the strict recency
    filter drops the item downstream) and `image` stays None (the article still publishes).
    Runs in parallel with a small bounded thread pool and a short timeout so a hanging
    publisher can't stall the hourly run.
    """
    def needs_fetch(item: dict[str, Any]) -> bool:
        if want_date and not item.get("published_at"):
            return True
        return bool(want_image and not item.get("image"))

    targets = [it for it in items if needs_fetch(it)]
    if not targets:
        return

    def fetch_one(item: dict[str, Any]) -> None:
        try:
            resp = requests.get(
                item["url"],
                timeout=ARTICLE_META_TIMEOUT,
                headers={
                    "User-Agent": ARTICLE_META_UA,
                    "Accept": "text/html,application/xhtml+xml",
                    "Accept-Language": "en-US,en;q=0.9",
                },
            )
            if resp.status_code != 200:
                return
            body = resp.text
            if want_date and not item.get("published_at"):
                iso = _parse_article_date(body)
                if iso:
                    item["published_at"] = iso
            if not item.get("image"):
                item["image"] = images.image_from_meta(body, item["url"])
        except Exception:  # noqa: BLE001
            return

    with ThreadPoolExecutor(max_workers=ARTICLE_META_WORKERS) as pool:
        list(pool.map(fetch_one, targets))


def _parse_article_date(html_text: str) -> str | None:
    # Cap the search rather than scanning a whole article. <meta> tags sit in the head, but
    # JSON-LD is often emitted deep in the body — baltimoreravens.com puts datePublished at
    # ~95KB — so the cap has to clear that or those sources silently lose every date.
    haystack = html_text[:200_000]
    for pattern in _ARTICLE_DATE_PATTERNS:
        m = pattern.search(haystack)
        if not m:
            continue
        raw = m.group(1).strip()
        iso = _normalize_iso(raw)
        if iso:
            return iso
    return None


def _normalize_iso(raw: str) -> str | None:
    """Normalize various ISO-ish date strings to a form the orchestrator's recency filter accepts
    (which uses datetime.fromisoformat with a Z→+00:00 swap).
    """
    if not raw:
        return None
    candidate = raw.replace("Z", "+00:00") if raw.endswith("Z") else raw
    try:
        from datetime import datetime
        return datetime.fromisoformat(candidate).isoformat()
    except ValueError:
        # Best-effort: return raw; if downstream can't parse it, recency filter drops the item.
        return raw
