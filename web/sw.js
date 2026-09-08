/* NFL Daily service worker.
 *
 * The app's own JSON is network-first, so an online app is current and an offline one still
 * has the last articles and brief. The shell is stale-while-revalidate, so the app opens
 * instantly from cache and picks up a deploy on the following open.
 *
 * Tweets are deliberately not cached here. They are paged, so every page shares one URL path
 * and they would overwrite each other; and data.js already keeps its own ordered copy of the
 * newest tweets in localStorage. Letting the request fail is what hands the app to that copy.
 */
const SHELL = "nfl-daily-shell-v16";
const SHELL_FILES = [
  "index.html", "app.css", "manifest.webmanifest",
  "js/main.js", "js/data.js", "js/store.js", "js/router.js",
  "js/lib/dom.js", "js/lib/icons.js", "js/lib/time.js", "js/lib/likes.js",
  "js/views/chrome.js", "js/views/feed.js", "js/views/tweet.js", "js/views/detail.js",
  "js/views/articles.js", "js/views/brief.js", "js/views/liked.js", "js/views/lightbox.js",
  "js/views/settings.js", "js/views/schedule.js", "js/views/dossier.js",
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
  if (url.origin !== location.origin) return;

  if (url.pathname.includes("/data/")) {
    // network-first: the current data when online, the last copy when not. Keyed without the
    // cache-busting query, or every load would store a new entry and match none of them.
    const key = stripQuery(e.request);
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        e.waitUntil(caches.open(SHELL).then(c => c.put(key, copy)));
        return res;
      }).catch(() => caches.match(key))
    );
    return;
  }

  // Stale-while-revalidate for the shell. Cache-first alone was wrong: it pinned the app to
  // whatever was cached and made every deploy invisible until this file's version string
  // changed by hand. Answering from cache keeps the app opening instantly; refreshing the
  // entry in the background means the next open is current, with no version bump needed.
  e.respondWith(
    caches.match(e.request).then(hit => {
      const fresh = fetch(e.request).then(res => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          e.waitUntil(caches.open(SHELL).then(c => c.put(e.request, copy)));
        }
        return res;
      }).catch(() => hit);
      return hit || fresh;
    })
  );
});

function stripQuery(req) {
  const u = new URL(req.url);
  u.search = "";
  return new Request(u.toString());
}
