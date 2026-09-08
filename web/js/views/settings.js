/* Usage and diagnostics.
 *
 * Reached from the masthead rather than the bottom bar: this answers a question asked monthly,
 * not a place you go. Everything here is read-only — the handle list and the poll cadence live
 * in config/sources.yaml, so nothing on a phone can change what this app spends.
 */

import { el, icon } from "../lib/dom.js";
import * as ICON from "../lib/icons.js";
import { state } from "../data.js";

const SCOPE_LABEL = { BAL: "Ravens", national: "NFL", rivals: "Rivals" };

export function renderSettings() {
  const wrap = el("div", { class: "settings" });
  wrap.appendChild(el("div", { class: "detail-bar" },
    el("a", { class: "icon-btn", href: "#/tweets", "aria-label": "Back" }, icon(ICON.BACK, {})),
    el("span", { text: "Usage" }),
  ));
  const body = el("div", { class: "settings-body" },
    el("div", { class: "settings-loading", text: "Loading usage…" }));
  wrap.appendChild(body);
  load(body);
  return wrap;
}

async function load(body) {
  const base = (state.config?.tweets_url || "").replace(/\/$/, "");
  if (!base) {
    body.replaceChildren(el("div", { class: "empty", text: "No usage source configured." }));
    return;
  }
  let data;
  try {
    const res = await fetch(`${base}/usage`, { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    body.replaceChildren(el("div", { class: "empty",
      text: "Couldn't load usage. Pull down to retry." }));
    return;
  }
  body.replaceChildren(
    spendSection(data),
    cadenceSection(data),
    handleSection(data),
    healthSection(),
    noteSection(data),
  );
}

/* ---------- what it cost ---------- */

function spendSection(data) {
  const m = data.month_to_date || {};
  return el("section", { class: "settings-section" },
    el("div", { class: "spend" },
      el("div", { class: "spend-now" }, usd(m.usd)),
      el("div", { class: "spend-sub",
        text: `this month · on pace for ${usd(m.projected_usd)}` }),
    ),
    el("div", { class: "spend-split" },
      splitRow("Tweets collected", m.tweets, usd(m.tweet_usd)),
      splitRow("Polling requests", m.requests, usd(m.schedule_usd)),
    ),
  );
}

function splitRow(label, count, amount) {
  return el("div", { class: "split-row" },
    el("span", { class: "split-label", text: label }),
    el("span", { class: "split-count", text: (count ?? 0).toLocaleString() }),
    el("span", { class: "split-usd", text: amount }),
  );
}

/* ---------- what a different cadence would cost ---------- */

function cadenceSection(data) {
  const rows = data.cadence || [];
  if (!rows.length) return el("div");
  const current = 5;   // the daytime cadence in worker/src/index.js
  const section = el("section", { class: "settings-section" },
    el("h2", { text: "Polling cadence" }),
    el("p", { class: "settings-note",
      text: "What each cadence would cost per month at the tweet volume seen so far. The tweets themselves cost the same either way — what changes is how many requests come back nearly empty." }),
  );
  const table = el("div", { class: "cadence" });
  for (const row of rows) {
    table.appendChild(el("div", { class: `cadence-row${row.minutes === current ? " is-current" : ""}` },
      el("span", { class: "cadence-min",
        text: `${row.minutes} min${row.minutes === current ? " · now" : ""}` }),
      el("span", { class: "cadence-req",
        text: `${(row.requests_per_day || 0).toLocaleString()}/day` }),
      el("span", { class: "cadence-usd", text: `${usd(row.usd_per_month)}/mo` }),
    ));
  }
  section.appendChild(table);
  return section;
}

/* ---------- what each account costs ---------- */

function handleSection(data) {
  const rows = (data.handles || []).filter(r => r.tweets > 0);
  const section = el("section", { class: "settings-section" },
    el("h2", { text: "By account" }),
    el("p", { class: "settings-note",
      text: "Tweets are billed per tweet, so this is exact. The cost of polling at all is shared by every account and is counted above instead." }),
  );
  if (!rows.length) {
    section.appendChild(el("div", { class: "settings-empty",
      text: "Nothing collected yet this month." }));
    return section;
  }
  const list = el("div", { class: "usage-list" });
  for (const r of rows) {
    list.appendChild(el("div", { class: `usage-row${r.watched ? "" : " is-dropped"}` },
      el("div", { class: "usage-who" },
        el("span", { class: "usage-handle", text: `@${r.handle}` }),
        el("span", { class: "usage-scope",
          text: r.watched ? (SCOPE_LABEL[r.scope] || r.scope || "") : "no longer watched" }),
      ),
      el("span", { class: "usage-tweets", text: (r.tweets || 0).toLocaleString() }),
      el("span", { class: "usage-usd", text: usd(r.usd) }),
    ));
  }
  section.appendChild(list);
  return section;
}

/* ---------- whether the fetchers are working ---------- */

function healthSection() {
  const health = state.feed?.source_health || [];
  if (!health.length) return el("div");
  const bad = health.filter(h => h.status !== "ok");
  const section = el("section", { class: "settings-section" },
    el("h2", { text: "Sources" }),
    el("p", { class: "settings-note",
      text: bad.length
        ? `${bad.length} of ${health.length} sources returned nothing on the last run.`
        : `All ${health.length} sources fetched normally on the last run.` }),
  );
  // Working sources are the boring case; only the ones that failed are worth the space.
  const list = el("div", { class: "usage-list" });
  for (const h of bad) {
    list.appendChild(el("div", { class: "usage-row" },
      el("div", { class: "usage-who" },
        el("span", { class: "usage-handle", text: h.id }),
        el("span", { class: "usage-scope", text: h.note || h.status }),
      ),
      el("span", { class: "usage-tweets", text: String(h.items_fetched ?? 0) }),
      el("span", { class: `usage-status is-${h.status}`, text: h.status }),
    ));
  }
  if (bad.length) section.appendChild(list);
  return section;
}

function noteSection(data) {
  const p = data.pricing || {};
  return el("section", { class: "settings-section" },
    el("p", { class: "settings-note",
      text: `Prices are computed from ${p.credits_per_tweet ?? 15} credits per tweet and a ${p.credits_per_request_floor ?? 26}-credit floor per request, at ${((p.credits_per_usd ?? 100000) / 1000).toLocaleString()}k credits to the dollar. twitterapi.io publishes no usage API, so these are calculated rather than billed.` }),
  );
}

function usd(n) {
  const v = Number(n || 0);
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
}
