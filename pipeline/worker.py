#!/usr/bin/env python3
"""Where the Cloudflare Worker lives.

The Worker's URL is not a secret. The browser app fetches tweets from it directly, so it ships
in the published `web/data/config.json` whatever we do here — keeping it only in an environment
variable bought no privacy and cost reliability instead: `publish.py` writes `tweets_url` from
the same variable, so any run that lacked it committed a config.json with an empty tweets_url
and the Tweets tab silently fell back to the stale tweets baked into feed.json.

Committing the default means a run that never sets the variable still writes a correct config.
`NFL_DAILY_WORKER_URL` still overrides, which is what a local Worker (`wrangler dev`) needs.

The push secret is a real secret and is not here — see `load_secret` in tweets.py.
"""

from __future__ import annotations

import os

DEFAULT_WORKER_URL = "https://nfl-daily-tweets.maeisen15.workers.dev"


def worker_base() -> str:
    """The Worker's base URL, no trailing slash. Never empty."""
    return (os.environ.get("NFL_DAILY_WORKER_URL") or DEFAULT_WORKER_URL).rstrip("/")
