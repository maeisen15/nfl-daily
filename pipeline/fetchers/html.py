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

DEFAULT_TIMEOUT = 15
DEFAULT_UA = "Mozilla/5.0"
# Article-meta enrichment uses a fuller browser-like UA since some publishers reject bare UAs
# on per-article pages even though their topic pages accept them.
ARTICLE_META_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
ARTICLE_META_WORKERS = 5
ARTICLE_META_TIMEOUT = 12


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

        if source.get("date_strategy") == "article_meta" and items:
            _enrich_dates_from_article_meta(items)

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
            }
        )
        if len(items) >= max_items:
            break
    return items


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


def _enrich_dates_from_article_meta(items: list[dict[str, Any]]) -> None:
    """For each item, GET the article URL and parse a publication date from common meta tags.

    Mutates items in place — sets `published_at` to an ISO 8601 string if extraction succeeds.
    Failures are silent (leave published_at=None); strict recency filter drops them downstream.
    Runs in parallel with a small thread pool.
    """
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
            iso = _parse_article_date(resp.text)
            if iso:
                item["published_at"] = iso
        except Exception:  # noqa: BLE001
            return

    with ThreadPoolExecutor(max_workers=ARTICLE_META_WORKERS) as pool:
        list(pool.map(fetch_one, items))


def _parse_article_date(html_text: str) -> str | None:
    # Cap the search to the document head + early body; meta tags live there and parsing
    # 500KB of article body is wasted work.
    haystack = html_text[:80_000]
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
