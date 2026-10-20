/* Hash routing. The hash is the whole route — no history API, no server rewrites, and a
 * reloaded or shared URL lands exactly where it was.
 *
 * The vertical leads the route (`#/nfl/tweets`, `#/politics/tweets`) so that reloading, sharing
 * or restoring a URL opens the right one. Callers never have to say which: `go("/articles")`
 * stays in the vertical you are already in, which is what every call site means. */

const VIEWS = ["tweets", "articles", "schedule", "brief", "liked", "settings"];

const listeners = new Set();

let known = [];       // vertical codes, in config order
let active = null;    // the one a route without a vertical belongs to

export function setVerticals(codes, activeCode) {
  known = codes.slice();
  active = known.includes(activeCode) ? activeCode : known[0] || null;
}

export function setActiveVertical(code) {
  if (known.includes(code)) active = code;
}

export function activeVertical() {
  return active;
}

export function parse() {
  const raw = (location.hash || "").replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query || "");

  // A hash saved before this app had verticals carries none, and belongs to the current one.
  const vertical = known.includes(parts[0]) ? parts.shift() : active;
  const route = (name, extra) => ({ name, vertical, params, ...extra });

  if (!parts.length) return route("tweets");
  if (parts[0] === "tweet" && parts[1]) return route("tweet", { id: parts[1] });
  if (parts[0] === "author" && parts[1]) return route("author", { handle: parts[1] });
  if (VIEWS.includes(parts[0])) return route(parts[0]);
  return route("tweets");
}

export function go(hash, { replace = false } = {}) {
  const target = qualify(hash);
  if (location.hash === target) return;
  if (replace) history.replaceState(null, "", target);
  else location.hash = target;
  if (replace) notify();
}

/* Put the active vertical in front of a bare path, so every existing `go("/tweets")` keeps
 * working and no call site has to care that verticals exist. */
function qualify(hash) {
  const clean = String(hash).replace(/^#/, "").replace(/^\/+/, "");
  const first = clean.split(/[/?]/)[0];
  if (!active || known.includes(first)) return `#/${clean}`;
  return `#/${active}/${clean}`;
}

/* The tab a route belongs to, which is what the bottom bar highlights — a tweet detail opened
 * from the feed still reads as "Tweets". */
export function tabFor(route) {
  // Settings is reached from the masthead, not the bottom bar, so it highlights nothing there.
  if (route.name === "settings") return null;
  if (["tweet", "liked", "author"].includes(route.name)) return "tweets";
  return route.name;
}

export function key(route) {
  // Scroll positions hang off this key, and two verticals showing the same view are two
  // different places to be scrolled in.
  const v = route.vertical || active || "-";
  if (route.name === "tweet") return `${v}:tweet:${route.id}`;
  if (route.name === "author") return `${v}:author:${route.handle}`;
  if (route.name === "schedule") {
    // Week paging deliberately shares one key so the list does not jump; the standings and a
    // team's season are separate places and remember their own positions.
    const team = route.params.get("team");
    if (team) return `${v}:schedule:team:${team}`;
    const view = route.params.get("view");
    return view ? `${v}:schedule:${view}` : `${v}:schedule`;
  }
  return `${v}:${route.name}`;
}

export function onRoute(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  const route = parse();
  for (const fn of listeners) fn(route);
}

window.addEventListener("hashchange", notify);
