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

## 5. Tell the Worker which handles to watch

The Worker polls twitterapi.io itself; there is no dashboard step and no webhook URL to set. It
builds its query from the `handles` table in D1, which the pipeline fills from
`config/sources.yaml`:

```bash
cd /Users/mattscomputer/Coding/nfl-daily
export NFL_DAILY_WORKER_URL=https://nfl-daily-tweets.maeisen15.workers.dev
export NFL_DAILY_PUSH_SECRET='<the push secret from step 3>'
python3 pipeline/tweets.py --mode sync-handles
```

**Billing starts at the first poll.** Roughly $1.17/month: ~26 credits per request (140 requests
a day, on the waking-hours cadence in `worker/src/index.js`) plus 15 credits per tweet returned.

Do **not** run `pipeline/rules.py sync --activate`. That reactivates the retired webhook's filter
rules, which bill 15 credits per rule per check whether or not anything matches — about
$12.87/month on top of everything else. The docstring in that file has the full story.

## 6. Add the GitHub secrets

The hourly refresh needs these. Go to
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

The poll's watermark starts at the newest tweet already stored, so on an empty store it reaches
back 26 hours on its own. To seed further back than that, or to pull in a handle you just added
without waiting for them to post again:

```bash
export NFL_DAILY_WORKER_URL=https://nfl-daily-tweets.maeisen15.workers.dev
export NFL_DAILY_PUSH_SECRET='<the push secret from step 3>'
python3 pipeline/tweets.py --mode search --since-hours 24
```

That is billed per tweet returned, so its price tracks how busy the window was — cheap in the
offseason, less so on a Sunday.

Then kick the app data over:

```bash
gh workflow run "Hourly refresh"     # or use the Actions tab
```

## Checking it later

```bash
curl https://nfl-daily-tweets.maeisen15.workers.dev/health
```

`last_poll` is the thing to read. Every poll records what it asked for and what came back,
because a poll that finds nothing and a poll that quietly broke look identical from outside:

```json
"last_poll": { "ok": true, "at": "...", "since": "...", "queries": 1,
               "pages": 1, "returned": 3, "written": 3, "est_credits": 71 }
```

`ok: false` carries an `error`. `queries` above 1 means the handle list outgrew a single request
and each poll now costs double the floor. `returned` persistently 0 during busy daytime hours,
with `ok: true`, is the signature of an over-length query — though the builder splits at 500
characters specifically to prevent that.

```bash
npx wrangler tail          # live Worker logs, from worker/
```

## Costs

| | |
|---|---|
| Cloudflare Workers + D1 | $0 (free tier) |
| GitHub Actions | $0 (unlimited on public repos) |
| twitterapi.io | ~$1.17/month — 140 polls/day plus ~100 tweets/day |

Top up at https://twitterapi.io. Balance is visible via
`curl -H "X-API-Key: $TWITTERAPI_IO_KEY" https://api.twitterapi.io/oapi/my/info` —
100,000 credits = $1.00.
