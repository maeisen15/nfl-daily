/* Where the reader is.
 *
 * A place in a feed is a post, not a number of pixels. The pixels above any given post change
 * whenever the feed is redrawn — new posts are folded in, an image finishes loading at a
 * different height, a "Show more" that was open is closed again — and a remembered offset then
 * points at whatever happens to be that far down now. So a position is recorded as the row at
 * the top of the screen and how far it sat from the top edge, and put back by finding that row
 * again. The raw offset is kept for views with no rows to hold on to.
 *
 * Positions are also written to sessionStorage, because the page does not always survive being
 * left: iOS discards a web app's page under memory pressure and loads it afresh on return,
 * which would otherwise drop the reader at the top of the feed with nothing to show why.
 * sessionStorage lasts exactly as long as that should be forgiven — through a reload, and not
 * past closing the app.
 */

const KEY = "streamwire.place.v1";
/* Close enough to the top that there is no place to keep: new posts should simply appear. */
const TOP_SLACK = 40;

export function capture(root) {
  const y = Math.max(0, window.scrollY);
  if (y <= TOP_SLACK) return { y };
  const row = topRow(root);
  if (!row) return { y };
  return { y, id: row.dataset.id, at: row.dataset.at || null,
           offset: Math.round(row.getBoundingClientRect().top) };
}

/* Returns whether the place was found. `strict` is for a place remembered from before a
 * reload: if its row is not on the page, the raw offset describes a page that no longer
 * exists, and the top is a more honest answer than somewhere arbitrary. */
export function restore(root, place, { strict = false } = {}) {
  if (!place) { window.scrollTo(0, 0); return false; }
  const row = place.id ? findRow(root, place.id) : null;
  if (row) {
    window.scrollTo(0, window.scrollY + row.getBoundingClientRect().top - (place.offset || 0));
    return true;
  }
  window.scrollTo(0, place.id && strict ? 0 : (place.y || 0));
  return !place.id;
}

/* Put a place back and keep it there while the page settles.
 *
 * A freshly drawn feed is briefly shorter than it will be: images above the row have not been
 * laid out yet, and each one that arrives pushes the row down the screen. So the row is held
 * where it belongs through every change in the page's height — until the reader touches the
 * screen, at which point the page is theirs, or until it has plainly stopped moving. */
const HOLD_MS = 4000;
let release = null;

export function restoreAndHold(root, place, opts) {
  if (release) release();
  const found = restore(root, place, opts);
  if (!found || !place || !place.id || !("ResizeObserver" in window)) return found;

  const watcher = new ResizeObserver(() => restore(root, place, opts));
  const stop = () => {
    watcher.disconnect();
    clearTimeout(timer);
    for (const type of LET_GO) window.removeEventListener(type, stop, true);
    release = null;
  };
  const timer = setTimeout(stop, HOLD_MS);
  for (const type of LET_GO) window.addEventListener(type, stop, { capture: true, passive: true });
  watcher.observe(root);
  release = stop;
  return found;
}

const LET_GO = ["touchstart", "wheel", "keydown", "mousedown"];

function findRow(root, id) {
  for (const row of root.querySelectorAll("[data-id]")) {
    if (row.dataset.id === id) return row;
  }
  return null;
}

/* The first row showing below the masthead. Probed rather than searched: a feed can be a
 * thousand rows long, and asking the browser what is at a point costs the same at any length.
 * The masthead covers the first probes while it is on screen, which is why there are several. */
function topRow(root) {
  const x = Math.floor(window.innerWidth / 2);
  for (let y = 8; y < window.innerHeight; y += 48) {
    const hit = document.elementFromPoint(x, y);
    const row = hit && hit.closest("[data-id]");
    if (row && root.contains(row)) return row;
  }
  return null;
}

export function save(state) {
  try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage disabled or full */ }
}

export function load() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(KEY) || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch { return null; }
}
