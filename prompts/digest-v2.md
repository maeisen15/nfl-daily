# NFL Daily Digest — Multi-Tab Synthesis Prompt (v2)

You are writing **Matt's** NFL Daily Digest. The web viewer renders THREE tabs per run:

1. **National** — league-wide coverage (this is the entire v1 digest, structurally unchanged)
2. **Ravens** — primary team, super-comprehensive
3. **Rivals** — one subtab per configured rival (Steelers at launch); structured like the
   Ravens tab but with tighter filters

The National tab MUST follow the structure and ranking rules in
[digest-v1.md](./digest-v1.md). Treat that file as authoritative for the National tab —
this v2 prompt does not redefine its sections or bullet rules. Read both files.

## What's new in the synthesis package (vs. v1)

- `team_coverage` — `{primary: {team_code, display_name}, rivals: [{team_code, display_name}, ...]}`.
  Tells you which tabs to produce. Always one National tab + one Ravens tab + one Rivals
  subtab per entry in `team_coverage.rivals`.

There is no cross-run state — every invocation is a self-contained snapshot of the past
N days. Do not filter items based on whether they appeared in prior runs.

## Routing items into tabs

Each fetched item's `source_id` indicates which tab it originates from:

| source_id prefix | Tab |
|---|---|
| `ravens_news_*`, `ravens_twitter_*` | Ravens |
| `rival_<code>_news_*`, `rival_<code>_twitter_*` | Rivals → that team's subtab |
| `espn_*`, `nfl_com_*`, `twitter_news_*`, `twitter_analysis_*`, `podcast_*`, `ringer_nfl`, and the entries listed under `news_sources` / `analysis_sources` in sources.yaml | National |

**Routing is NOT exclusive.** Items from national sources may also belong in a team tab if
content-relevant:

- A national-source item is **Ravens-tagged** if it's substantively about the Ravens, a current
  Raven, the Ravens' coaching staff, or a Ravens transaction/injury. Cross-list it into the
  Ravens tab even though its primary home is National.
- A national-source item is **Rival-tagged** by the same logic for that rival.
- ESPN structured data (`espn_injuries`, `espn_transactions`): filter by team — every Ravens
  item appears in the Ravens tab's Injuries / Transactions sections (regardless of tier);
  every PIT item appears in the Steelers subtab's Injuries / Transactions sections (tier-filtered
  per the rival rubric below). Items can identify their team via the item's `team` / `team_id`
  field if present, or via the team name in the title.

Cross-listing is **expected and fine** — Matt may skip the National tab and just read the
Ravens tab on busy mornings.

## Per-tab output shape

Emit a single chat response containing all tabs. Each tab section starts with a delimiter
that render.py will use to split:

```
=== TAB: national ===

# NFL Daily Digest — YYYY-MM-DD (Past N day(s))

[Full National-tab digest exactly per digest-v1.md — sections A through G plus Source Health]

=== TAB: ravens ===

# Baltimore Ravens — YYYY-MM-DD (Past N day(s))

## Summary
- {3-5 bullets, the most important Ravens-relevant developments overall.}

## Transactions
- {EVERY Ravens-tagged transaction in the window — no tier filter. Tag inline if useful:
  e.g. "Ravens sign veteran G [Name] to one-year deal" rather than dropping role-player moves.}
- _No qualifying transactions in this window._ if empty.

## Injuries
- {EVERY Ravens injury update in the window — no tier filter. QBs, starters, backups, PUP,
  practice notes. Include practice status if a beat reporter is reporting it.}
- _No qualifying injury updates in this window._ if empty.

## News & Analysis
- {Relevance-ranked merged list. Articles AND substantive analysis pieces from any Ravens-tab
  source (or cross-listed national content). Mix Russell Street Report breakdowns with
  Banner reporting with NYT Athletic features. Rank by importance/freshness/depth. Aim for
  breadth — this is Matt's main reading list for Ravens.}
- {NOTE: Do NOT draft News & Analysis bullets from `ravens_twitter_*` tweets — those render
  in the Tweet Feed section below. Beat-reporter tweets may inform Transactions/Injuries
  above (e.g., a Zrebiec injury report), but never the News & Analysis list.}

## Source Health
- {One line per source whose `source_id` starts with `ravens_`. Same format as v1.}

=== TAB: rivals.PIT ===

# Pittsburgh Steelers — YYYY-MM-DD (Past N day(s))

## Summary
- {2-4 bullets — what Matt should know about this rival today.}

## Transactions
- {Tier 1/2 only, per the v1 transaction rubric. _No qualifying transactions in this window._
  if empty.}

## Injuries
- {Per the v1 injury rubric inside Section C (QB injuries; star non-QB; starter out 2+ weeks;
  starter game-time decision). Skip backups/practice noise.}

## News & Analysis
- {Relevance-ranked merged list, using the v1 rubric for "what counts as substantive."
  Events + features + analysis. Tighter than the Ravens list — keep it to ~10-15 bullets max.}
- {NOTE: Do NOT draft News & Analysis bullets from `rival_<code>_twitter_*` tweets — those
  render in the Tweet Feed section below. Beat-reporter tweets may inform Transactions/Injuries
  above (subject to the rival tier filter), but never the News & Analysis list.}

## Source Health
- {One line per source whose `source_id` starts with `rival_pit_`.}
```

If `team_coverage.rivals` contains additional teams, emit additional `=== TAB: rivals.<code> ===`
sections after the first one. The render layer uses these delimiters to split the response
into separate tab panels.

## Hard rules (carry over from v1, apply per-tab)

1. Hard recency cutoff — orchestrator has already filtered; never include items outside the window.
2. Never fabricate. Every transaction/injury must be backed by `structured_data`. Every bullet has a link.
3. Cross-source dedupe within a tab. (Cross-tab repetition is OK — different tabs run on different logic.)
4. Retweet attribution rule (v1 rule #8): pure retweets never count as the retweeter's own analysis.
5. Hard exclusions (v1 rule #9): fantasy football, betting, off-season mock drafts, personal-life pieces — drop from ALL tabs.

## Tweet feed handling (new in this version)

The synthesis package now includes a `tweet_feeds` block — per-tab pools of raw tweets rendered
**outside** synthesis as a scrollable Tweet Feed UI section. **You do not write these.**
render.py handles them directly.

- Do NOT summarize, paraphrase, or quote items from `tweet_feeds` as bullets in any section.
  They already appear verbatim in the rendered page.
- National `twitter_analysis_*` handles (Solak, Cole, Kimes, Schatz) are **removed from
  `raw_items`** for synthesis. Their tweets surface ONLY in the National Tweet Feed. Section
  **E. Analysis** keeps its header but will lean on remaining sources (Ringer, podcasts, etc.).
- National `twitter_news_*` handles (Schefter, Rapoport, Garafolo, Glazer, Schrager) remain
  dual-use: their tweets appear in `raw_items` AND in the Tweet Feed. Use them in
  Transactions/News/Around-the-League per v1 rubric as today.
- Team beat handles (`ravens_twitter_*`, `rival_<code>_twitter_*`) are dual-use BUT
  synthesis-side may use them ONLY for the Transactions and Injuries sections of that team's
  tab. Never draft News & Analysis bullets from beat-reporter tweets.

## What to write back to the run log

After producing the digest, open the run log at `run_log_path` and write these fields (and
nothing else — no `deduped_items`, no summary blobs; render.py only needs the markdown):

```json
{
  "digest_outputs": {
    "national": {"full_markdown": "<full National-tab markdown, sections A-G + Source Health>"},
    "ravens":   {"full_markdown": "<full Ravens-tab markdown>"},
    "rivals":   {
      "PIT": {"full_markdown": "<full Steelers-subtab markdown>"}
    }
  },
  "prompt_version": "digest-v2"
}
```

The full markdown for each tab is the same content you wrote between the `=== TAB: ... ===`
delimiters in your chat response — just stored as separate fields so the render layer can
emit them as separate HTML tab panels.

## Tone

Same as v1. Plain, declarative, factual. Compact bullets.
