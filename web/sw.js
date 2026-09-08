/* NFL Daily service worker.
 *
 * Data (the app's JSON and the Worker's tweets) is network-first, so an online app is always
 * current and an offline one still has the last feed. The shell is stale-while-revalidate, so
 * the app opens instantly from cache and picks up a deploy on the following open.
 */
const SHELL = "nfl-daily-shell-v11";
const SHELL_FILES = [
  "index.html", "app.css", "manifest.webmanifest",
  "js/main.js", "js/data.js", "js/store.js", "js/router.js",
  "js/lib/dom.js", "js/lib/icons.js", "js/lib/time.js", "js/lib/likes.js",
  "js/views/chrome.js", "js/views/feed.js", "js/views/tweet.js", "js/views/detail.js",
  "js/views/articles.js", "js/views/brief.js", "js/views/liked.js", "js/views/lightbox.js",
];

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
    // Stale-while-revalidate for the shell. Cache-first alone was wrong: it pinned the app to
    // whatever was cached and made every deploy invisible until this file's version string
    // changed by hand. Answering from cache keeps the app opening instantly; refreshing the
    // entry in the background means the next open is current, with no version bump needed.
    e.respondWith(
      caches.match(e.request).then(hit => {
        const fresh = fetch(e.request).then(res => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(SHELL).then(c => c.put(e.request, copy));
          }
          return res;
        }).catch(() => hit);
        return hit || fresh;
      })
    );
  }
});

function stripQuery(req) {
  const u = new URL(req.url);
  u.search = "";
  return new Request(u.toString());
}
