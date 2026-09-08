/* Schedule, scores and standings.
 *
 * Scope-aware: the selector at the top still means something here. Ravens opens their season,
 * Rivals shows the five teams the Rivals tab follows, NFL shows the whole week. From any of
 * them every week and every team is reachable, so the scope picks a starting point rather than
 * fencing anything off.
 *
 * State lives in the URL — #/schedule?week=3, ?view=standings, ?team=BAL — so a reload lands
 * where you were and the back button behaves.
 */

import { el } from "../lib/dom.js";
import { store } from "../store.js";
import { state, loadSchedule } from "../data.js";

const RIVAL_TEAMS = ["PIT", "CIN", "CLE", "KC", "BUF"];

export function renderSchedule(params) {
  const wrap = el("div", { class: "schedule" });
  // Already loaded: build now. Filling this in from a promise would hand main.js an empty
  // element to restore the scroll position against, and the position would be lost.
  if (state.schedule) {
    wrap.replaceChildren(...build(state.schedule, params));
    return wrap;
  }
  wrap.appendChild(el("div", { class: "sched-loading", text: "Loading schedule…" }));
  loadSchedule()
    .then(data => wrap.replaceChildren(...build(data, params)))
    .catch(() => wrap.replaceChildren(el("div", { class: "empty",
      text: "Couldn't load the schedule. Pull down to retry." })));
  return wrap;
}

function build(data, params) {
  const view = params.get("view");
  const team = params.get("team");
  if (view === "standings") return [tabs("standings"), standings(data)];
  if (team) return [tabs("games"), teamSeason(data, team, true)];
  // Following one team, the season is the useful view — week paging would make you hunt for
  // the one game that matters. The league scopes are the other way round.
  const scope = store.scope;
  if (scope && scope !== "national" && scope !== "rivals") {
    return [tabs("games"), teamSeason(data, scope, false)];
  }
  return [tabs("games"), weekView(data, params)];
}

function tabs(active) {
  const mk = (label, key, href) => el("a", {
    class: `sched-tab${key === active ? " is-active" : ""}`, href, text: label,
  });
  return el("div", { class: "sched-tabs" },
    mk("Games", "games", "#/schedule"),
    mk("Standings", "standings", "#/schedule?view=standings"),
  );
}

/* ---------- one week ---------- */

function weekView(data, params) {
  const weeks = data.weeks || [];
  const wanted = Number(params.get("week")) || data.current_week;
  const index = Math.max(0, weeks.findIndex(w => w.week === wanted));
  const week = weeks[index];
  if (!week) return el("div", { class: "empty", text: "No games scheduled." });

  const scope = store.scope;
  const only = scope === "rivals" ? RIVAL_TEAMS : scope === "national" ? null : [scope];
  const games = only
    ? week.games.filter(g => only.includes(g.home?.abbr) || only.includes(g.away?.abbr))
    : week.games;

  const out = el("div", {},
    weekNav(weeks, index),
  );

  if (!games.length) {
    out.appendChild(el("div", { class: "sched-empty",
      text: scope === "rivals"
        ? "None of the rival teams play this week."
        : "No game this week — bye." }));
    // A team on a bye still wants the rest of the league available rather than a dead end.
    out.appendChild(el("a", { class: "sched-allgames", href: "#/schedule?view=standings",
      text: "See the standings" }));
    return out;
  }

  let lastDay = null;
  for (const game of games) {
    const day = dayLabel(game.date);
    if (day !== lastDay) {
      lastDay = day;
      out.appendChild(el("div", { class: "sched-day", text: day }));
    }
    out.appendChild(gameRow(game));
  }
  return out;
}

function weekNav(weeks, index) {
  const prev = weeks[index - 1];
  const next = weeks[index + 1];
  const arrow = (target, label, dir) => target
    ? el("a", { class: "sched-arrow", href: `#/schedule?week=${target.week}`, "aria-label": label },
        el("span", { text: dir }))
    : el("span", { class: "sched-arrow is-off", text: dir });
  return el("div", { class: "sched-nav" },
    arrow(prev, "Previous week", "‹"),
    el("span", { class: "sched-week", text: weeks[index].label }),
    arrow(next, "Next week", "›"),
  );
}

function gameRow(game) {
  const live = game.state === "in";
  const done = game.state === "post";
  const row = el("div", { class: `sched-game${live ? " is-live" : ""}` },
    el("div", { class: "sched-teams" },
      side(game.away, game, done),
      side(game.home, game, done),
    ),
    el("div", { class: "sched-meta" },
      el("span", { class: `sched-status${live ? " is-live" : ""}`,
        text: done ? "Final" : live ? `${game.status || ""}` : kickoff(game.date) }),
      game.network ? el("span", { class: "sched-network", text: game.network }) : null,
    ),
  );
  return row;
}

function side(team, game, done) {
  if (!team) return el("div");
  // A finished game dims the loser, which is how a column of results is read at a glance.
  const lost = done && !team.winner && game.home?.score !== game.away?.score;
  return el("a", {
    class: `sched-side${lost ? " is-lost" : ""}`,
    href: team.abbr ? `#/schedule?team=${team.abbr}` : null,
  },
    teamLogo(team.abbr),
    el("span", { class: "sched-team", text: team.name || team.abbr || "" }),
    el("span", { class: "sched-record", text: !done && team.record ? team.record : "" }),
    el("span", { class: "sched-score", text: team.score == null ? "" : String(team.score) }),
  );
}

/* ---------- one team's season ---------- */

function teamSeason(data, abbr, canBack) {
  const games = [];
  for (const week of data.weeks || []) {
    const game = week.games.find(g => g.home?.abbr === abbr || g.away?.abbr === abbr);
    if (game) games.push({ ...game, label: week.label });
  }
  if (!games.length) {
    return el("div", { class: "empty", text: "No schedule for that team." });
  }
  const self = games[0].home?.abbr === abbr ? games[0].home : games[0].away;
  const out = el("div", {},
    el("div", { class: "sched-nav" },
      canBack
        ? el("a", { class: "sched-arrow", href: "#/schedule", "aria-label": "Back" },
            el("span", { text: "‹" }))
        : el("span", { class: "sched-arrow is-off" }),
      el("span", { class: "sched-week" }, teamLogo(abbr),
        el("span", { text: self?.full || abbr })),
      el("span", { class: "sched-arrow is-off" }),
    ),
  );
  for (const game of games) {
    const home = game.home?.abbr === abbr;
    const other = home ? game.away : game.home;
    const done = game.state === "post";
    const mine = home ? game.home : game.away;
    out.appendChild(el("a", {
      class: "sched-fixture",
      href: other?.abbr ? `#/schedule?team=${other.abbr}` : null,
    },
      el("span", { class: "fixture-week", text: game.label }),
      el("span", { class: "fixture-side", text: home ? "vs" : "at" }),
      teamLogo(other?.abbr),
      el("span", { class: "fixture-team", text: other?.name || other?.abbr || "" }),
      done
        ? el("span", { class: `fixture-result ${mine?.winner ? "is-win" : "is-loss"}`,
            text: `${mine?.winner ? "W" : "L"} ${mine?.score}-${other?.score}` })
        // Kickoff time, not just the date: knowing a game is Sunday night is most of what the
        // schedule is for.
        : el("span", { class: "fixture-when" },
            el("span", { class: "fixture-date", text: shortDate(game.date) }),
            el("span", { class: "fixture-time", text: kickoff(game.date) }),
            game.network ? el("span", { class: "fixture-net", text: game.network }) : null,
          ),
    ));
  }
  return out;
}

/* ---------- standings ---------- */

function standings(data) {
  const out = el("div", { class: "standings" });
  for (const conf of data.standings || []) {
    for (const div of conf.divisions || []) {
      out.appendChild(el("div", { class: "standings-head" },
        el("span", { text: div.name }),
        el("span", { class: "standings-cols" },
          el("span", { text: "W" }), el("span", { text: "L" }),
          el("span", { text: "T" }), el("span", { text: "PCT" })),
      ));
      for (const team of div.teams || []) {
        out.appendChild(el("a", { class: "standings-row", href: `#/schedule?team=${team.abbr}` },
          teamLogo(team.abbr),
          el("span", { class: "standings-team", text: team.name || team.abbr }),
          el("span", { class: "standings-cols" },
            el("span", { text: String(team.wins ?? 0) }),
            el("span", { text: String(team.losses ?? 0) }),
            el("span", { text: String(team.ties ?? 0) }),
            el("span", { text: team.pct || "—" })),
        ));
      }
    }
  }
  return out;
}

/* ---------- bits ---------- */

function teamLogo(abbr) {
  if (!abbr) return el("span", { class: "team-logo is-blank" });
  const img = el("img", { class: "team-logo", src: `icons/teams/${abbr}.png`, alt: "",
    loading: "lazy", decoding: "async" });
  img.addEventListener("error", () => {
    img.replaceWith(el("span", { class: "team-logo is-blank", text: abbr.slice(0, 2) }));
  });
  return img;
}

function dayLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

function kickoff(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function shortDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}
