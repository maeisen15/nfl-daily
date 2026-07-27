#!/usr/bin/env python3
"""Check that every source domain in config/sources.yaml is covered by the cloud network
allowlist (docs/network-allowlist.txt). A source on a domain missing from the allowlist gets a
403 at the cloud proxy and silently shows "error" in the app's source health — this turns that
silent failure into a visible one.

Usage:  python3 scripts/check_allowlist.py
Exit 0 = all covered; exit 1 = missing domains (printed).
"""
import os
import sys
from urllib.parse import urlparse

import yaml

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCES = os.path.join(REPO, "config", "sources.yaml")
ALLOWLIST = os.path.join(REPO, "docs", "network-allowlist.txt")

# Hidden-API hosts the fetchers hit that don't appear as URLs in sources.yaml.
EXTRA_HOSTS = {"site.api.espn.com", "api.twitterapi.io", "api.foxsports.com"}


def apex(host):
    return ".".join(host.lower().split(".")[-2:])


def source_apexes():
    with open(SOURCES) as f:
        cfg = yaml.safe_load(f)
    hosts = set(EXTRA_HOSTS)

    def walk(node):
        if isinstance(node, dict):
            for v in node.values():
                if isinstance(v, str) and v.startswith("http"):
                    h = urlparse(v).netloc
                    if h and "localhost" not in h:
                        hosts.add(h.lower())
                else:
                    walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(cfg)
    return {apex(h) for h in hosts}


def allowlist_apexes():
    covered = set()
    with open(ALLOWLIST) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            covered.add(apex(line.lstrip("*.")))
    return covered


def main():
    required = source_apexes()
    covered = allowlist_apexes()
    missing = sorted(required - covered)
    if missing:
        print("MISSING from docs/network-allowlist.txt (and the cloud routine's allowlist):",
              file=sys.stderr)
        for m in missing:
            print(f"  {m}\n  *.{m}", file=sys.stderr)
        print(f"\n{len(missing)} domain(s) uncovered — add them both places or the "
              "scheduled run will 403.", file=sys.stderr)
        return 1
    print(f"OK — all {len(required)} source domains are covered by the allowlist.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
