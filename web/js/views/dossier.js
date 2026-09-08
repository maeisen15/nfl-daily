/* The game-week dossier: the top of the Ravens brief.
 *
 * Not a summary of the day — it answers whether you are ready for Sunday, and it fills in as
 * the week goes: the matchup and the statistical picture from Monday, practice reports
 * accumulating Wednesday to Friday, designations and a usable forecast by Saturday.
 *
 * Everything here is assembled from data rather than written. A model summarising a practice
 * table would only add a way for it to be wrong.
 */

import { el, safeUrl } from "../lib/dom.js";
import { state, fetchOpponentTweets } from "../data.js";
import { store, set, mergeTweets } from "../store.js";
import { tweetRow, hydrateClamps } from "./tweet.js";

const DAY_HEAD = { Wed: "Wed", Thu: "Thu", Fri: "Fri", Sat: "Sat", Sun: "Sun", Mon: "Mon", Tue: "Tue" };
const PRACTICE_CLASS = { DNP: "is-dnp", Limited: "is-limited", Full: "is-full" };

export function renderDossier(scope) {
  const data = state.gameweek;
  if (!data || !data.game) return null;
  // The dossier belongs to the team tab, and the file itself says which team it describes.
  // Matching the scope code against it would break silently if the followed team ever changed.
  const role = (state.config?.scopes || []).find(s => s.code === scope)?.role;
  if (role !== "primary") return null;

  const wrap = el("section", { class: "dossier" });
  for (const part of [
    matchup(data),
    previews(data),
    injuries(data),
    opponentBeat(data),
    statsTable(data.stats),
    weather(data.weather),
  ]) {
    if (part) wrap.appendChild(part);
  }
  return wrap;
}

/* ---------- the matchup ---------- */

function matchup(data) {
  const g = data.game;
  const kick = new Date(g.date);
  const when = isNaN(kick) ? "" : kick.toLocaleString(undefined, {
    weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  return el("div", { class: "dossier-head" },
    el("div", { class: "dossier-week", text: data.week_label || "" }),
    el("div", { class: "dossier-matchup" },
      teamBlock(g.away), el("span", { class: "dossier-at", text: "at" }), teamBlock(g.home),
    ),
    el("div", { class: "dossier-when" },
      el("span", { text: when }),
      g.network ? el("span", { class: "dossier-net", text: g.network }) : null,
    ),
    g.venue ? el("div", { class: "dossier-venue", text: g.venue }) : null,
  );
}

function teamBlock(side) {
  if (!side) return el("div");
  return el("div", { class: "dossier-team" },
    el("img", { class: "dossier-logo", src: `icons/teams/${side.abbr}.png`, alt: "" }),
    el("span", { class: "dossier-name", text: side.name || side.abbr }),
    el("span", { class: "dossier-record", text: side.record || "" }),
  );
}

/* ---------- weather ---------- */

function weather(wx) {
  if (!wx) return null;
  if (wx.roof === "dome") {
    return section("Weather", el("div", { class: "dossier-note", text: `Indoors — ${wx.venue}.` }));
  }
  if (wx.roof === "neutral") {
    return section("Weather", el("div", { class: "dossier-note",
      text: wx.venue ? `Neutral site — ${wx.venue}.` : "Neutral site." }));
  }
  if (!wx.forecast) {
    return section("Weather",
      el("div", { class: "dossier-note", text: "Too far out for a forecast." }));
  }
  const f = wx.forecast;
  // A missing value must not become a confident zero: Math.round(null) is 0, which would read
  // as a real forecast of no wind.
  const num = (v, suffix) => (typeof v === "number" ? `${Math.round(v)}${suffix}` : "—");
  const body = el("div", { class: "wx" },
    wxCell(num(f.temperature_f, "°"), "at kickoff"),
    wxCell(num(f.wind_mph, " mph"), "wind"),
    wxCell(num(f.precipitation_pct, "%"), "precipitation"),
  );
  const note = wx.roof === "retractable"
    ? el("div", { class: "dossier-note", text: "Retractable roof." })
    : null;
  return section("Weather", body, note);
}

function wxCell(big, label) {
  return el("div", { class: "wx-cell" },
    el("div", { class: "wx-value", text: big }),
    el("div", { class: "wx-label", text: label }),
  );
}

/* ---------- statistics ---------- */

function statsTable(stats) {
  if (!stats || (!stats.offense?.length && !stats.defense?.length)) return null;
  const body = el("div", { class: "cmp" });
  body.appendChild(el("div", { class: "cmp-head" },
    el("span", { class: "cmp-side", text: stats.away }),
    el("span", { class: "cmp-label", text: "" }),
    el("span", { class: "cmp-side", text: stats.home }),
  ));
  for (const [title, rows] of [["Offense", stats.offense], ["Defense", stats.defense]]) {
    if (!rows?.length) continue;
    body.appendChild(el("div", { class: "cmp-group", text: title }));
    for (const row of rows) body.appendChild(cmpRow(row));
  }
  return section("Matchup", body);
}

function cmpRow(row) {
  return el("div", { class: "cmp-row" },
    cmpCell(row.away, row.better === "away"),
    el("span", { class: "cmp-label", text: row.label }),
    cmpCell(row.home, row.better === "home"),
  );
}

function cmpCell(cell, best) {
  if (!cell) return el("span", { class: "cmp-cell" });
  return el("span", { class: `cmp-cell${best ? " is-best" : ""}` },
    el("span", { class: "cmp-value", text: cell.value ?? "" }),
    cell.rank ? el("span", { class: "cmp-rank", text: ordinal(cell.rank) }) : null,
  );
}

/* ---------- injuries ---------- */

function injuries(data) {
  const grid = data.injuries;
  // Teams file their first practice report on Wednesday for a Sunday game, so an empty grid
  // early in the week is the schedule working, not the fetch failing — and saying so is more
  // useful than showing nothing and leaving it ambiguous.
  if (!grid || !grid.days?.length) {
    return section("Injury report",
      el("div", { class: "dossier-note", text: waitingLine(data) }));
  }
  const wrap = el("div");
  let any = false;
  for (const team of [data.team, data.opponent]) {
    const rows = grid.teams?.[team] || [];
    if (!rows.length) continue;
    any = true;
    wrap.appendChild(el("div", { class: "inj-team" },
      el("img", { class: "inj-logo", src: `icons/teams/${team}.png`, alt: "" }),
      el("span", { text: team === data.team ? "Ravens" : team }),
    ));
    wrap.appendChild(injTable(rows, grid.days));
  }
  return any ? section("Injury report", wrap) : null;
}

function injTable(rows, days) {
  // The grid grows a column per practice day as the week goes on, so the column count is data,
  // not a constant.
  const table = el("div", { class: "inj", style: `--inj-days:${days.length}` });
  table.appendChild(el("div", { class: "inj-row is-head" },
    el("span", { class: "inj-player", text: "" }),
    ...days.map(d => el("span", { class: "inj-day", text: dayHead(d) })),
    el("span", { class: "inj-status", text: "" }),
  ));
  for (const r of rows) {
    table.appendChild(el("div", { class: "inj-row" },
      el("span", { class: "inj-player" },
        el("span", { class: "inj-pos", text: r.position || "" }),
        el("span", { class: "inj-name", text: r.player }),
        r.injury ? el("span", { class: "inj-detail", text: r.injury }) : null,
      ),
      ...days.map(d => {
        const v = r.practice?.[d];
        return el("span", {
          class: `inj-day ${v ? PRACTICE_CLASS[v] || "" : "is-none"}`,
          // One letter per day: the whole report fits on a screen, which is the point of it.
          text: v ? v[0] : "–",
          title: v || "",
        });
      }),
      el("span", { class: "inj-status", text: short(r.status) }),
    ));
  }
  return table;
}

/* Designations are long words in a narrow column, and only the first letters carry meaning. */
function short(status) {
  if (!status) return "";
  const map = { Questionable: "Q", Doubtful: "D", Out: "OUT", "Injured Reserve": "IR" };
  return map[status] || status;
}

/* Wednesday for a Sunday game; a Thursday or Monday kickoff shifts the whole week.
 *
 * Read in Eastern rather than on the device. The filing calendar belongs to the league, not to
 * wherever the phone happens to be — from Tokyo a Sunday 1pm kickoff is Monday morning, and
 * the device's own weekday would answer for the wrong game. */
function waitingLine(data) {
  const kick = new Date(data.game?.date);
  if (isNaN(kick)) return "No injury report yet.";
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short",
  }).format(kick);
  const first = weekday === "Thu" ? "Monday" : weekday === "Mon" ? "Thursday" : "Wednesday";
  return `No injury report yet. First comes out ${first}.`;
}

function dayHead(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (isNaN(d)) return iso.slice(5);
  const name = d.toLocaleDateString(undefined, { weekday: "short" });
  return DAY_HEAD[name] || name;
}

/* ---------- game previews ---------- */

function previews(data) {
  const items = data.previews || [];
  if (!items.length) return null;
  const list = el("div", { class: "opp-news" });
  for (const item of items) {
    const href = safeUrl(item.url);
    list.appendChild(el(href ? "a" : "div", {
      class: "opp-item",
      ...(href ? { href, target: "_blank", rel: "noopener" } : {}),
      text: item.title || "",
    }));
  }
  return section("Game previews", list);
}

/* ---------- the opponent's beat writer ---------- */

/* One reporter's week, in a box you scroll inside — rather than a long list you have to scroll
 * past to reach the rest of the dossier. A national feed that merely mentions the team was the
 * wrong thing here: the person who covers them every day says more in a week than a wire
 * service does. */
function opponentBeat(data) {
  const beat = data.opponent_beat;
  if (!beat) return null;
  const scroller = el("div", { class: "beat-scroll" },
    el("div", { class: "beat-loading", text: "Loading…" }));

  fetchOpponentTweets(beat.handle, 30).then(items => {
    if (!items.length) {
      scroller.replaceChildren(el("div", { class: "beat-loading",
        text: "Nothing from this week yet." }));
      return;
    }
    // Into the store, so tapping one opens its detail view. These carry the `opponent` scope,
    // which no feed filters on, so they cannot leak into a tab.
    set({ tweets: mergeTweets(store.tweets, items) });
    scroller.replaceChildren(...items.map(t => tweetRow(t)));
    hydrateClamps(scroller);
  }).catch(() => {
    scroller.replaceChildren(el("div", { class: "beat-loading",
      text: "Couldn't load these." }));
  });

  return section(`${teamLabel(data)} beat`,
    el("div", { class: "beat-who", text: beat.name || `@${beat.handle}` }),
    scroller);
}

function teamLabel(data) {
  const g = data.game;
  const side = g.home?.abbr === data.opponent ? g.home : g.away;
  return side?.name || data.opponent;
}

/* ---------- bits ---------- */

function section(title, ...body) {
  return el("div", { class: "dossier-section" },
    el("h2", { text: title }),
    ...body.filter(Boolean),
  );
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
