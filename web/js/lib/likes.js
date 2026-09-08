/* Liked tweets.
 *
 * A like is a private gesture: nothing is sent to Twitter and nothing is public. The whole
 * tweet is copied, not just its id, because the Worker prunes tweets after seven days — an
 * id-only list would silently empty itself every week.
 *
 * Storage is localStorage, which belongs to this site alone and lives on the device. iOS
 * evicts script-writable storage after seven days of inactivity for ordinary Safari tabs but
 * exempts home-screen web apps, which is how this one is used.
 *
 * Everything goes through this module so the backing store can move to the Worker's D1 later
 * without any view knowing.
 */

const KEY = "nfl-daily.likes.v1";

let cache = null;

function read() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    cache = parsed && typeof parsed === "object" && parsed.items ? parsed : { items: {} };
  } catch {
    // Private mode, disabled site data, or corrupt JSON. An in-memory store keeps the session
    // working; it just won't survive a reload.
    cache = { items: {} };
  }
  return cache;
}

function write() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Quota or a blocked accessor. The gesture still reads as done for this session.
  }
}

export function has(id) {
  return !!id && Object.prototype.hasOwnProperty.call(read().items, id);
}

export function count() {
  return Object.keys(read().items).length;
}

/* Returns the new liked state. The stored copy is the tweet as displayed — for a retweet that
 * is the original post, which is what was actually liked. */
export function toggle(id, tweet) {
  if (!id) return false;
  const store = read();
  if (store.items[id]) {
    delete store.items[id];
    write();
    return false;
  }
  store.items[id] = { liked_at: new Date().toISOString(), tweet };
  write();
  return true;
}

/* Newest like first — this is a save-for-later list, so recency of the saving is the order
 * that makes sense, not the age of the tweet. */
export function all() {
  return Object.entries(read().items)
    .map(([id, v]) => ({ id, liked_at: v.liked_at, tweet: v.tweet }))
    .filter(e => e.tweet)
    .sort((a, b) => (a.liked_at < b.liked_at ? 1 : -1));
}
