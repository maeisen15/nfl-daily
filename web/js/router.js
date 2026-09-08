/* Hash routing. The hash is the whole route — no history API, no server rewrites, and a
 * reloaded or shared URL lands exactly where it was. */

const listeners = new Set();

export function parse() {
  const raw = (location.hash || "").replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  const params = new URLSearchParams(query || "");
  if (!parts.length) return { name: "tweets", params };
  if (parts[0] === "tweet" && parts[1]) return { name: "tweet", id: parts[1], params };
  if (["tweets", "articles", "brief", "liked", "settings"].includes(parts[0])) return { name: parts[0], params };
  return { name: "tweets", params };
}

export function go(hash, { replace = false } = {}) {
  const target = hash.startsWith("#") ? hash : `#${hash}`;
  if (location.hash === target) return;
  if (replace) history.replaceState(null, "", target);
  else location.hash = target;
  if (replace) notify();
}

/* The tab a route belongs to, which is what the bottom bar highlights — a tweet detail opened
 * from the feed still reads as "Tweets". */
export function tabFor(route) {
  // Settings is reached from the masthead, not the bottom bar, so it highlights nothing there.
  if (route.name === "settings") return null;
  if (route.name === "tweet" || route.name === "liked") return "tweets";
  return route.name;
}

export function key(route) {
  return route.name === "tweet" ? `tweet:${route.id}` : route.name;
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
