#!/usr/bin/env python3
"""Manage the twitterapi.io tweet filter rules that drive the live webhook.

A rule is an OR-chained `from:` query. When a matching tweet posts, twitterapi.io POSTs it to
the webhook URL configured for the account, which is the Worker's /ingest. Billing is per
matched tweet, so the rules are the only real cost lever — keep them tight.

The webhook URL itself is NOT settable through the API; it lives in the twitterapi.io
dashboard. Rules are therefore created inactive and only activated once that URL is in place,
so no tweet is ever matched (and billed) with nowhere to deliver it.

Usage:
    python3 pipeline/rules.py list
    python3 pipeline/rules.py sync            # create/update rules from sources.yaml, inactive
    python3 pipeline/rules.py sync --activate # ...and switch them on
    python3 pipeline/rules.py deactivate      # switch every managed rule off (stops billing)
"""
from __future__ import annotations

import argparse
import sys

import requests

from tweets import API_BASE, TIMEOUT, load_handles, load_secret

# The API caps a rule's `value` at 255 characters, so the handle list splits across rules.
MAX_RULE_CHARS = 255
RULE_PREFIX = "nfl-daily"
# How often twitterapi.io checks for matches. Cost is per matched tweet, not per check, so a
# short interval buys freshness for free. 60s keeps the app effectively live.
INTERVAL_SECONDS = 60


def main() -> int:
    ap = argparse.ArgumentParser(description="Manage twitterapi.io filter rules")
    ap.add_argument("command", choices=("list", "sync", "deactivate"))
    ap.add_argument("--activate", action="store_true",
                    help="With `sync`: activate the rules (only once the webhook URL is set).")
    args = ap.parse_args()

    key = load_secret("TWITTERAPI_IO_KEY")
    if not key:
        print("ERROR: TWITTERAPI_IO_KEY not set", file=sys.stderr)
        return 1

    if args.command == "list":
        for r in get_rules(key):
            state = "ACTIVE " if r.get("is_effect") else "paused "
            print(f"{state} {r.get('rule_id')}  tag={r.get('tag')!r}  "
                  f"every {r.get('interval_seconds')}s")
            print(f"         {r.get('value')}")
        return 0

    existing = {r.get("tag"): r for r in get_rules(key)}

    if args.command == "deactivate":
        for tag, rule in existing.items():
            if str(tag).startswith(RULE_PREFIX) and rule.get("is_effect"):
                update_rule(key, rule["rule_id"], tag, rule["value"],
                            rule.get("interval_seconds") or INTERVAL_SECONDS, 0)
                print(f"paused {tag}")
        return 0

    handles = load_handles()
    wanted = build_rules(handles)
    print(f"{len(handles)} handles -> {len(wanted)} rule(s)", file=sys.stderr)

    for tag, value in wanted:
        effect = 1 if args.activate else 0
        if tag in existing:
            rule = existing[tag]
            update_rule(key, rule["rule_id"], tag, value, INTERVAL_SECONDS, effect)
            print(f"updated {tag} ({'active' if effect else 'paused'}) [{len(value)} chars]")
        else:
            rule_id = add_rule(key, tag, value, INTERVAL_SECONDS)
            print(f"created {tag} -> {rule_id} [{len(value)} chars]")
            if effect:
                update_rule(key, rule_id, tag, value, INTERVAL_SECONDS, 1)
                print(f"activated {tag}")

    # A handle removed from sources.yaml must stop matching, or it keeps costing money.
    wanted_tags = {t for t, _ in wanted}
    for tag, rule in existing.items():
        if str(tag).startswith(RULE_PREFIX) and tag not in wanted_tags and rule.get("is_effect"):
            update_rule(key, rule["rule_id"], tag, rule["value"],
                        rule.get("interval_seconds") or INTERVAL_SECONDS, 0)
            print(f"paused stale rule {tag}")

    if not args.activate:
        print("\nRules are PAUSED. Set the webhook URL in the twitterapi.io dashboard, then:",
              file=sys.stderr)
        print("  python3 pipeline/rules.py sync --activate", file=sys.stderr)
    return 0


def build_rules(handles: list[dict]) -> list[tuple[str, str]]:
    """Pack handles into as few rules as the 255-char limit allows, newest-tab-agnostic (the
    Worker routes on author handle, so a rule may span scopes)."""
    suffix = " include:nativeretweets"
    budget = MAX_RULE_CHARS - len(suffix)
    rules: list[tuple[str, str]] = []
    group, length = [], 0
    for h in handles:
        term = f"from:{h['handle']}"
        add_len = len(term) + (4 if group else 0)
        if group and length + add_len > budget:
            rules.append(("", " OR ".join(group) + suffix))
            group, length = [], 0
            add_len = len(term)
        group.append(term)
        length += add_len
    if group:
        rules.append(("", " OR ".join(group) + suffix))
    return [(f"{RULE_PREFIX}-{i}", value) for i, (_, value) in enumerate(rules, 1)]


def get_rules(key: str) -> list[dict]:
    body = api(key, "GET", "/oapi/tweet_filter/get_rules")
    return body.get("rules") or []


def add_rule(key: str, tag: str, value: str, interval: int) -> str:
    body = api(key, "POST", "/oapi/tweet_filter/add_rule",
               {"tag": tag, "value": value, "interval_seconds": interval})
    return body.get("rule_id", "")


def update_rule(key: str, rule_id: str, tag: str, value: str, interval: int, effect: int) -> None:
    api(key, "POST", "/oapi/tweet_filter/update_rule",
        {"rule_id": rule_id, "tag": tag, "value": value,
         "interval_seconds": interval, "is_effect": effect})


def api(key: str, method: str, path: str, payload: dict | None = None) -> dict:
    resp = requests.request(method, f"{API_BASE}{path}", json=payload, timeout=TIMEOUT,
                            headers={"X-API-Key": key, "Accept": "application/json"})
    resp.raise_for_status()
    body = resp.json()
    if body.get("status") == "error":
        raise RuntimeError(f"{path}: {body.get('msg')}")
    return body


if __name__ == "__main__":
    raise SystemExit(main())
