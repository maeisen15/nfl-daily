#!/usr/bin/env python3
"""Confirm the live site is actually serving the run we just published.

Pushing to main is not the same as deploying. GitHub Pages can fail (or silently never
start) after a perfectly good push — a GitHub Actions outage on 2026-08-06 ate two runs
this way, and both reported success because nothing downstream of `git push` was checked.
The app served day-old news for hours.

This closes that loop: read the run_id we just wrote into web/data/feed.json, then poll the
live URL until it serves the same run_id.

Usage:  python3 scripts/verify_deploy.py            # after git push
        python3 scripts/verify_deploy.py --timeout 600

Exit 0 = live site matches the local publish.
Exit 1 = timed out; the deploy did not land (details printed).
"""
import argparse
import json
import os
import sys
import time

import requests

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL_FEED = os.path.join(REPO_ROOT, "web", "data", "feed.json")
LIVE_FEED = "https://maeisen15.github.io/nfl-daily/data/feed.json"

POLL_SECONDS = 15
DEFAULT_TIMEOUT = 300


def local_run_id(path):
    if not os.path.exists(path):
        sys.exit(f"no local feed at {path} — run pipeline/publish.py first")
    with open(path) as f:
        return (json.load(f) or {}).get("run_id")


def live_feed(url):
    """(run_id, generated_at, error). Cache-busted — Pages sits behind a CDN."""
    try:
        resp = requests.get(
            url,
            params={"_cb": str(time.time())},
            timeout=20,
            headers={"Cache-Control": "no-cache"},
        )
        if resp.status_code != 200:
            return None, None, f"HTTP {resp.status_code}"
        # GitHub occasionally serves a partial object mid-deploy; treat that as not-yet.
        data = json.loads(resp.text, strict=False)
        return data.get("run_id"), data.get("generated_at"), None
    except Exception as exc:  # noqa: BLE001
        return None, None, f"{type(exc).__name__}: {exc}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=LIVE_FEED)
    ap.add_argument("--local", default=LOCAL_FEED)
    ap.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                    help=f"seconds to wait for the deploy (default {DEFAULT_TIMEOUT})")
    args = ap.parse_args()

    expected = local_run_id(args.local)
    if not expected:
        sys.exit("local feed.json has no run_id")
    print(f"expecting run_id {expected} at {args.url}")

    deadline = time.time() + args.timeout
    seen, generated, err = None, None, None
    while time.time() < deadline:
        seen, generated, err = live_feed(args.url)
        if seen == expected:
            print(f"OK — live site is serving {seen} (generated {generated})")
            return 0
        remaining = int(deadline - time.time())
        print(f"  live={seen or err} — waiting ({remaining}s left)")
        time.sleep(POLL_SECONDS)

    print("", file=sys.stderr)
    print(f"DEPLOY DID NOT LAND: live site still serving {seen or err}, "
          f"expected {expected}.", file=sys.stderr)
    print("The data is committed and pushed — only the deploy is missing. Check, in order:",
          file=sys.stderr)
    print("  1. https://github.com/maeisen15/nfl-daily/actions — did a run start? did it fail?",
          file=sys.stderr)
    print("  2. https://www.githubstatus.com — an Actions/Pages incident stops deploys "
          "even though the push succeeded", file=sys.stderr)
    print("  3. If Actions is healthy again, any new push to main re-triggers the deploy.",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
