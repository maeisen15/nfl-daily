# Design reference

The Tweets tab is built to read like Twitter. These are the reference shots it is built
against — the target, and the problems it replaces.

## The target

| File | What to take from it |
|---|---|
| `twitter-feed-gif.png` | The baseline row: 40px avatar left, name/handle/time on one line that never wraps, hairline separators, no card borders. A quoted tweet as a bordered inset card. Inline GIF with its badge. |
| `twitter-feed-showmore.png` | `Show more` truncation on a long tweet. A quoted tweet whose image renders as a **small square thumbnail beside the text**, not full width. A retweet as `🔁 Ryan Mink reposted` above the original author's own row. |
| `twitter-thread.png` | Thread connection: the vertical gray line running down the avatar column between consecutive tweets by the same author. Link preview cards — hero image, headline overlay, `From russellstreetreport.com` beneath. |
| `twitter-tweet-detail.png` | The detail view: larger text, absolute timestamp and view count on their own line, the full engagement row below a divider. |

## What it replaces

| File | The problem |
|---|---|
| `current-feed-top.png` | Condensed uppercase names, boxed cards, timestamp colliding with the card edge. |
| `current-retweets-truncated.png` | Retweets at their worst — a four-line wrapped name, an `RT @HANDLE` pill floating mid-row, and body text cut off at `right on trac...` because we stored Twitter's legacy 140-character string instead of the original post. |
| `current-quoted-tweet.png` | A quoted tweet that can't be tapped, reachable only through an `Open quoted post ↗` text link. |
