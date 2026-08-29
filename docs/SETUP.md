# Setup — live tweets

The app's tweets come from a Cloudflare Worker that twitterapi.io pushes to. This is the
one-time wiring. Everything else (articles, the digest) already runs without it.

Run every command from `/Users/mattscomputer/Coding/nfl-daily`.

## 1. Cloudflare account and login

Free tier is enough — the Worker's traffic is far below the limits.

```bash
npx wrangler login
```

Opens a browser to authorize. Sign up at https://dash.cloudflare.com/sign-up first if needed.

## 2. Create the database

```bash
cd worker
npx wrangler d1 create nfl-daily-tweets
```

It prints a `database_id`. Put that value into `worker/wrangler.toml`, replacing
`14efdd29-da90-44cc-b48f-f1f65fe50ddb` (already set). Then create the tables:

```bash
npx wrangler d1 execute nfl-daily-tweets --remote --file=schema.sql
```

## 3. Set the Worker's two secrets

```bash
npx wrangler secret put TWITTERAPI_IO_KEY   # paste your twitterapi.io key
npx wrangler secret put PUSH_SECRET         # paste the value below
```

Generate the push secret with `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`
and keep it somewhere you can paste from — you need the same value again in steps 6, 7 and 8.
Do not put it in a file in this repo: the repo is public.

`TWITTERAPI_IO_KEY` is how the Worker recognises twitterapi.io: the service sends your own
key back in the `X-API-Key` header on every push, and the Worker rejects anything else.
`PUSH_SECRET` is separate so the pipeline's sweeps authenticate independently — rotating one
doesn't force rotating the other.

## 4. Deploy

```bash
npx wrangler deploy
```

Note the URL it prints, e.g. `https://nfl-daily-tweets.maeisen15.workers.dev`. Check it:

```bash
curl https://nfl-daily-tweets.maeisen15.workers.dev/health
```

Expect `{"ok":true,"tweets":0,...}`.

## 5. Point twitterapi.io at it

The webhook URL can only be set in their dashboard — there's no API for it.

1. Go to https://twitterapi.io → Tweet Filter Rules
2. Paste `https://nfl-daily-tweets.maeisen15.workers.dev/ingest` into **Webhook URL**
3. Save

Then create and switch on the rules that decide which handles are watched:

```bash
cd /Users/mattscomputer/Coding/nfl-daily
python3 pipeline/rules.py sync --activate
python3 pipeline/rules.py list
```

Both rules should read `ACTIVE`. **Billing starts here** — you pay $0.00015 per matched
tweet, roughly $1.10/month at current volume. `python3 pipeline/rules.py deactivate` stops it.

## 6. Add the GitHub secrets

The hourly refresh and the sweeps need these. Go to
https://github.com/maeisen15/nfl-daily/settings/secrets/actions and add three:

| Name | Value |
|---|---|
| `NFL_DAILY_WORKER_URL` | `https://nfl-daily-tweets.maeisen15.workers.dev` |
| `NFL_DAILY_PUSH_SECRET` | the push secret from step 3 |
| `TWITTERAPI_IO_KEY` | your twitterapi.io key |

## 7. Add the same to the cloud digest environment

The 5pm digest agent reads tweets from the Worker. Its environment already holds
`TWITTERAPI_IO_KEY`; add `NFL_DAILY_WORKER_URL` and `NFL_DAILY_PUSH_SECRET` alongside it:

claude.ai/code → routine **NFL Daily — 5pm digest** → environment settings → variables.

While you're there, confirm the network allowlist includes `workers.dev` and
`*.workers.dev` (see `docs/network-allowlist.txt`), or the digest run can't reach the Worker.

## 8. Seed the store

The webhook only delivers tweets posted *after* the rules go live, so backfill the last day:

```bash
export NFL_DAILY_WORKER_URL=https://nfl-daily-tweets.maeisen15.workers.dev
export NFL_DAILY_PUSH_SECRET='<the push secret from step 3>'
python3 pipeline/tweets.py --mode search --since-hours 24
```

Then kick the app data over:

```bash
gh workflow run "Hourly refresh"     # or use the Actions tab
```

## Checking it later

```bash
curl https://nfl-daily-tweets.maeisen15.workers.dev/health
```

`by_source` tells you which path tweets arrived by. A healthy store shows a growing
`webhook` count; if that number stops moving while `search` keeps climbing, the webhook has
stopped and the daily sweep is carrying the app — check the rules are still `ACTIVE` and the
webhook URL is still set in the dashboard.

```bash
npx wrangler tail          # live Worker logs, from worker/
```

## Costs

| | |
|---|---|
| Cloudflare Workers + D1 | $0 (free tier) |
| GitHub Actions | $0 (unlimited on public repos) |
| twitterapi.io | ~$2.70/month — live pushes, daily sweep, weekly backstop |

Top up at https://twitterapi.io. Balance is visible via
`curl -H "X-API-Key: $TWITTERAPI_IO_KEY" https://api.twitterapi.io/oapi/my/info` —
100,000 credits = $1.00.
