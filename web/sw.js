/* NFL Daily service worker — cache shell, network-first for data. */
const SHELL = "nfl-daily-shell-v8";
const SHELL_FILES = ["index.html", "app.css", "app.js", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Live tweets come from the Worker on another origin. Cache them the same way as /data/ so
  // the Tweets tab still has something to show on a plane or a dead cell.
  const isLiveTweets = url.hostname.endsWith(".workers.dev") && url.pathname === "/tweets";
  if (url.origin !== location.origin && !isLiveTweets) return;
  if (isLiveTweets || url.pathname.includes("/data/")) {
    // network-first: fresh feed when online, last cached feed when offline
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(stripQuery(e.request), copy));
        return res;
      }).catch(() => caches.match(stripQuery(e.request)))
    );
  } else {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
  }
});

function stripQuery(req) {
  const u = new URL(req.url);
  u.search = "";
  return new Request(u.toString());
}
