"""Article image extraction helpers, shared by the RSS and HTML fetchers.

Every function here is best-effort and never raises: an article with no image must still
publish normally, so a malformed URL or a weird feed shape returns None rather than an error.

Rules enforced in one place:
  - absolute https only (http is dropped — the app is served over https and a mixed-content
    image is a broken image, which is worse than an intentional text row)
  - no data: URIs
  - anything with known dimensions below MIN_DIMENSION is skipped as a thumbnail/tracking pixel
  - obvious tracking pixels and spacers are skipped by URL shape
"""
from __future__ import annotations

import html as html_lib
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import urljoin, urlparse

import requests

MIN_DIMENSION = 200
MAX_URL_LEN = 2000

# Some publishers reject bare user agents on article pages even when their feed accepts one.
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
# ...and ESPN's Akamai does the opposite: a rich browser UA gets HTTP 202 with an empty body
# (it expects a JS challenge to be solved), while a minimal UA is served the real page. So we
# try both, in this order, and stop at the first that yields an image.
MINIMAL_UA = "Mozilla/5.0"
FALLBACK_UAS = (BROWSER_UA, MINIMAL_UA)
# Bounded pool + (connect, read) timeouts: a slow publisher costs seconds, not the run.
OG_FETCH_WORKERS = 5
OG_FETCH_TIMEOUT = (5, 10)

# Tracking pixels, spacers and ad beacons. Matched against the whole URL.
_JUNK_URL_RE = re.compile(
    r"(?:"
    r"/1x1|[-_.]1x1|pixel\.(?:gif|png)|spacer\.|blank\.(?:gif|png)|transparent\.|"
    r"doubleclick\.net|googlesyndication|scorecardresearch|quantserve|"
    r"feedburner\.com/~|/rsspixel|/beacon"
    r")",
    re.I,
)

# Site furniture. Only applied to images harvested out of an index page's markup, where a
# logo or an author headshot really can sit next to the headline. og:image is authoritative
# and is never filtered by this.
_DECORATIVE_URL_RE = re.compile(
    r"(?:logo|sprite|favicon|avatar|headshot|placeholder|default[-_]image|/icons?[/-])",
    re.I,
)

# Some feeds ship a doubled scheme ("https://https://cdn…" — the Post-Gazette does this on
# every enclosure). Collapse it rather than throwing away an otherwise good image.
_DUP_SCHEME_RE = re.compile(r"^https?://(?=https?://)", re.I)
_HOSTNAME_RE = re.compile(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$", re.I)

_IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.I)
_ATTR_RE = re.compile(r"""\b([a-zA-Z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""")

# og:image / twitter:image, both attribute orders. First match wins.
_META_IMAGE_PATTERNS = [
    re.compile(r'<meta[^>]+?property=["\']og:image(?::secure_url|:url)?["\'][^>]*?content=["\']([^"\']+)', re.I),
    re.compile(r'<meta[^>]+?content=["\']([^"\']+)["\'][^>]*?property=["\']og:image(?::secure_url|:url)?["\']', re.I),
    re.compile(r'<meta[^>]+?name=["\']twitter:image(?::src)?["\'][^>]*?content=["\']([^"\']+)', re.I),
    re.compile(r'<meta[^>]+?content=["\']([^"\']+)["\'][^>]*?name=["\']twitter:image(?::src)?["\']', re.I),
]


def clean_image_url(raw: Any, base: str | None = None) -> str | None:
    """Normalize a candidate image URL, or None if it isn't usable.

    `base` is the article URL; relative candidates are resolved against it.
    """
    try:
        if not raw or not isinstance(raw, str):
            return None
        url = html_lib.unescape(raw.strip())
        if not url or url.startswith("data:"):
            return None
        if url.startswith("//"):
            url = "https:" + url
        elif not url.startswith(("http://", "https://")):
            if not base:
                return None
            url = urljoin(base, url)
        for _ in range(3):
            if not _DUP_SCHEME_RE.match(url):
                break
            url = url[url.index("://") + 3:]
        if len(url) > MAX_URL_LEN:
            return None
        parsed = urlparse(url)
        if parsed.scheme != "https" or not _HOSTNAME_RE.match(parsed.netloc):
            return None
        if "." not in parsed.netloc:
            return None
        if _JUNK_URL_RE.search(url):
            return None
        return url
    except Exception:  # noqa: BLE001 — never let an image break an article
        return None


def looks_decorative(url: str) -> bool:
    """True for logos, avatars and other site furniture. Index-page harvest only."""
    return bool(url and _DECORATIVE_URL_RE.search(url))


def dimensions_ok(width: Any, height: Any) -> bool:
    """False only when a dimension is known AND too small. Unknown dimensions pass."""
    for value in (width, height):
        n = _as_int(value)
        if n is not None and n < MIN_DIMENSION:
            return False
    return True


def area(width: Any, height: Any) -> int:
    w, h = _as_int(width), _as_int(height)
    if w is None or h is None:
        return 0
    return w * h


def _as_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(str(value).strip().rstrip("px") or 0) or None
    except (TypeError, ValueError):
        return None


def image_from_meta(html_text: str, base: str | None = None) -> str | None:
    """Pull og:image (or twitter:image) out of a fetched article page."""
    if not html_text:
        return None
    # Meta tags live in <head>; parsing a 500KB article body is wasted work.
    haystack = html_text[:80_000]
    for pattern in _META_IMAGE_PATTERNS:
        m = pattern.search(haystack)
        if not m:
            continue
        url = clean_image_url(m.group(1), base)
        if url:
            return url
    return None


def fill_missing_images(items: list[dict[str, Any]]) -> None:
    """Opt-in pass: GET each item's article page and read og:image from it.

    Only for sources whose feed carries no image and that aren't already fetching the article
    page for some other reason — one extra request per item, so it is config-gated
    (`fetch_og_image: true`). Items that already have an image are skipped. Mutates in place;
    every failure is silent and leaves `image` as None.
    """
    targets = [it for it in items if it.get("url") and not it.get("image")]
    if not targets:
        return

    def fetch_one(item: dict[str, Any]) -> None:
        for ua in FALLBACK_UAS:
            try:
                resp = requests.get(
                    item["url"],
                    timeout=OG_FETCH_TIMEOUT,
                    headers={
                        "User-Agent": ua,
                        "Accept": "text/html,application/xhtml+xml",
                        "Accept-Language": "en-US,en;q=0.9",
                    },
                )
                if resp.status_code != 200:
                    continue
                url = image_from_meta(resp.text, item["url"])
                if url:
                    item["image"] = url
                    return
            except Exception:  # noqa: BLE001
                continue

    with ThreadPoolExecutor(max_workers=OG_FETCH_WORKERS) as pool:
        list(pool.map(fetch_one, targets))


def image_from_html(fragment: str, base: str | None = None) -> str | None:
    """Pull the first usable <img> out of an HTML fragment (RSS content/summary)."""
    if not fragment or "<img" not in fragment.lower():
        return None
    for tag in _IMG_TAG_RE.findall(fragment):
        attrs = _tag_attrs(tag)
        if not dimensions_ok(attrs.get("width"), attrs.get("height")):
            continue
        url = _url_from_img_attrs(attrs, base)
        if url and not looks_decorative(url):
            return url
    return None


def image_from_img_tag(tag: Any, base: str | None = None) -> str | None:
    """Pull a usable URL out of a BeautifulSoup <img> element, honoring lazy-load attrs."""
    try:
        attrs = {k.lower(): v for k, v in (tag.attrs or {}).items()}
    except Exception:  # noqa: BLE001
        return None
    if not dimensions_ok(attrs.get("width"), attrs.get("height")):
        return None
    return _url_from_img_attrs(attrs, base)


# Lazy-loading attributes, in the order publishers actually populate them.
_SRC_ATTRS = ("src", "data-src", "data-original", "data-lazy-src", "data-image")
_SRCSET_ATTRS = ("srcset", "data-srcset", "data-lazy-srcset")


def _url_from_img_attrs(attrs: dict[str, Any], base: str | None) -> str | None:
    for key in _SRC_ATTRS:
        url = clean_image_url(attrs.get(key), base)
        if url:
            return url
    for key in _SRCSET_ATTRS:
        url = _largest_from_srcset(attrs.get(key), base)
        if url:
            return url
    return None


def _largest_from_srcset(srcset: Any, base: str | None) -> str | None:
    """Pick the widest candidate from a srcset. Returns None if none are usable."""
    if not srcset or not isinstance(srcset, str):
        return None
    best: tuple[int, str] | None = None
    for part in srcset.split(","):
        bits = part.strip().split()
        if not bits:
            continue
        url = clean_image_url(bits[0], base)
        if not url:
            continue
        width = 0
        if len(bits) > 1 and bits[1].endswith("w"):
            width = _as_int(bits[1][:-1]) or 0
        if width and width < MIN_DIMENSION:
            continue
        if best is None or width > best[0]:
            best = (width, url)
    return best[1] if best else None


def _tag_attrs(tag_html: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in _ATTR_RE.finditer(tag_html):
        name = m.group(1).lower()
        value = m.group(2) or m.group(3) or m.group(4) or ""
        out.setdefault(name, value)
    return out
