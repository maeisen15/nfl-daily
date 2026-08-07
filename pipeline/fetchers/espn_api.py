"""ESPN hidden API fetcher.

Handles two specific shapes that don't fit the generic `api.py`:

  1. INJURIES — `/apis/site/v2/sports/football/nfl/injuries`
     Returns {timestamp, status, season, injuries: [{id, displayName, injuries: [...]}]}
     The outer list is per-team; the inner `injuries` is the actual records. We flatten
     into one Item per injury record (player + status + comment).

  2. TRANSACTIONS — `/apis/site/v2/sports/football/nfl/transactions?limit=N`
     Returns {timestamp, status, season, requestedYear, count, pageIndex, pageSize, pageCount, transactions}.
     Each transaction has {date, description, team: {id, location, name, abbreviation,
     displayName, color, ...}}. Team is EXPANDED INLINE — no $ref to follow. Single endpoint
     returns current transactions across all seasons sorted desc by date.
     (`sports.core.api.espn.com/.../seasons/<YEAR>/` is NOT a usable fallback — it returns
     count:0 for the current season. These site API paths are the only live source.)

Both paths are served by two interchangeable hosts, `site.api.espn.com` and
`site.web.api.espn.com`. ESPN sits behind Akamai, which intermittently answers 403
"Access Denied" for a given caller — datacenter egress IPs (as in the cloud sandbox) get
blocked far more often than residential ones. A 403 is therefore treated as retryable and we
walk the whole host chain before giving up; see `_get_json`.

Per-source config in sources.yaml `structured_data` tier:
  - id, name
  - type: "espn_injuries" | "espn_transactions"
  - link_destination (string, the public URL the digest links bullets to)
  - max_items (int, default 200)
"""
from __future__ import annotations

import time
from typing import Any

import requests

DEFAULT_TIMEOUT = 15

# Interchangeable hosts for the same site API paths. Tried in order; a blocked or failing host
# falls through to the next. Keep both in docs/network-allowlist.txt and the cloud routine's
# network settings.
HOSTS = ("site.api.espn.com", "site.web.api.espn.com")

INJURIES_PATH = "/apis/site/v2/sports/football/nfl/injuries"
TRANSACTIONS_PATH = "/apis/site/v2/sports/football/nfl/transactions"

# Akamai keys partly on the header set looking like ESPN's own site XHR. Sending a bare
# "Mozilla/5.0" with no Referer is the shape most likely to be denied.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.espn.com/",
    "Origin": "https://www.espn.com",
}

ATTEMPTS_PER_HOST = 3
BACKOFF_SECONDS = (1, 3)  # sleep after attempt 1, then after attempt 2


def _get_json(path: str, params: dict[str, Any] | None = None) -> tuple[dict[str, Any] | None, str | None]:
    """GET `path` from the first host that answers. Returns (json, error_note).

    Retries within each host before moving on, since Akamai's denials are intermittent —
    the same request often succeeds seconds later.
    """
    failures: list[str] = []
    for host in HOSTS:
        url = f"https://{host}{path}"
        for attempt in range(1, ATTEMPTS_PER_HOST + 1):
            try:
                resp = requests.get(url, params=params, timeout=DEFAULT_TIMEOUT, headers=HEADERS)
                if resp.status_code == 200:
                    return resp.json(), None
                failures.append(f"{host} attempt {attempt}: HTTP {resp.status_code}")
            except Exception as exc:  # noqa: BLE001
                failures.append(f"{host} attempt {attempt}: {type(exc).__name__}: {exc}")
            if attempt < ATTEMPTS_PER_HOST:
                time.sleep(BACKOFF_SECONDS[attempt - 1])
    return None, "; ".join(failures)


def fetch(source: dict[str, Any]) -> dict[str, Any]:
    kind = source.get("type")
    if kind == "espn_injuries":
        return _fetch_injuries(source)
    if kind == "espn_transactions":
        return _fetch_transactions(source)
    return {
        "source_id": source["id"],
        "status": "error",
        "items_fetched": 0,
        "latency_ms": 0,
        "note": f"unknown ESPN api type: {kind!r}",
        "items": [],
    }


def _fetch_injuries(source: dict[str, Any]) -> dict[str, Any]:
    source_id = source["id"]
    link_destination = source.get("link_destination", "https://www.espn.com/nfl/injuries")
    max_items = source.get("max_items", 200)
    started = time.monotonic()
    note: str | None = None
    items: list[dict[str, Any]] = []
    status = "ok"

    data, err = _get_json(INJURIES_PATH)
    if data is None:
        status = "error"
        note = f"ESPN injuries unreachable on all hosts — {err}"
    else:
        teams = data.get("injuries") or []  # list of teams
        for team in teams:
            team_name = team.get("displayName") or ""
            for inj in team.get("injuries") or []:
                items.append(_normalize_injury(source_id, inj, team_name, link_destination))
                if len(items) >= max_items:
                    break
            if len(items) >= max_items:
                break

        if not items:
            status = "warn"
            note = "ESPN injuries endpoint returned no records"

    latency_ms = int((time.monotonic() - started) * 1000)
    return {
        "source_id": source_id,
        "status": status,
        "items_fetched": len(items),
        "latency_ms": latency_ms,
        "note": note,
        "items": items,
    }


def _normalize_injury(
    source_id: str, inj: dict[str, Any], team_name: str, link_dest: str
) -> dict[str, Any]:
    athlete = inj.get("athlete") or {}
    name = (athlete.get("displayName") or "").strip() or "Unknown player"
    position = ((athlete.get("position") or {}).get("abbreviation") or "").strip()
    inj_type = (inj.get("type") or {}).get("description") if isinstance(inj.get("type"), dict) else inj.get("type")
    inj_type = (inj_type or "").strip()
    status_label = (inj.get("status") or "").strip()
    short = (inj.get("shortComment") or "").strip()
    long_comment = (inj.get("longComment") or "").strip()

    pos_label = f" ({position})" if position else ""
    team_label = f" — {team_name}" if team_name else ""
    type_label = f" [{inj_type}]" if inj_type else ""
    title_bits = [f"{name}{pos_label}{team_label}{type_label}"]
    if status_label:
        title_bits.append(status_label)
    title = ": ".join(title_bits)

    return {
        "source_id": source_id,
        "title": title,
        "url": link_dest,
        "published_at": _coerce_iso(inj.get("date")),
        "snippet": short or long_comment[:240],
        "author": None,
        "team": team_name or None,  # authoritative team, for accurate tab routing
    }


def _fetch_transactions(source: dict[str, Any]) -> dict[str, Any]:
    source_id = source["id"]
    link_destination = source.get("link_destination", "https://www.espn.com/nfl/transactions")
    max_items = source.get("max_items", 200)
    started = time.monotonic()
    note: str | None = None
    items: list[dict[str, Any]] = []
    status = "ok"

    data, err = _get_json(TRANSACTIONS_PATH, params={"limit": max_items})
    if data is None:
        status = "error"
        note = f"ESPN transactions unreachable on all hosts — {err}"
    else:
        for raw in data.get("transactions") or []:
            items.append(_normalize_transaction(source_id, raw, link_destination))
            if len(items) >= max_items:
                break
        if not items:
            status = "warn"
            note = f"ESPN transactions endpoint returned 0 records (count reported: {data.get('count')})"

    latency_ms = int((time.monotonic() - started) * 1000)
    return {
        "source_id": source_id,
        "status": status,
        "items_fetched": len(items),
        "latency_ms": latency_ms,
        "note": note,
        "items": items,
    }


def _normalize_transaction(source_id: str, raw: dict[str, Any], link_dest: str) -> dict[str, Any]:
    description = (raw.get("description") or "").strip()
    date_iso = _coerce_iso(raw.get("date"))
    team = raw.get("team") or {}
    team_name = (team.get("displayName") or "").strip() if isinstance(team, dict) else ""
    # Prepend team to description for stronger title — "Bears: Signed RB Salvon Ahmed..."
    title = f"{team_name}: {description}" if team_name and description else (description or "Transaction")
    return {
        "source_id": source_id,
        "title": title,
        "url": link_dest,
        "published_at": date_iso,
        "snippet": None,
        "author": None,
        "team": team_name or None,  # authoritative transacting team, for accurate tab routing
    }


def _coerce_iso(value: Any) -> str | None:
    if not value:
        return None
    if isinstance(value, str):
        # ESPN dates come back as e.g. "2026-05-21T07:00Z" — already ISO 8601.
        return value
    return None
