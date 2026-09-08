/* The tweet feed: the app's front page.
 *
 * Chronological, newest first, seven days deep. Threads collapse into one item so a six-tweet
 * thread never eats the screen, and new tweets are held behind a pill rather than inserted
 * under a thumb mid-read.
 */

import { el, frag } from "../lib/dom.js";
import { dayLabel } from "../lib/time.js";
import { store, set, tweetsForScope, pendingForScope, mergeTweets } from "../store.js";
import { tweetRow, hydrateClamps } from "./tweet.js";
import { go } from "../router.js";
import { fetchTweets } from "../data.js";

export function renderFeed(scope) {
  const items = tweetsForScope(scope);
  const wrap = el("div", { class: "feed" });

  if (!items.length) {
    wrap.appendChild(el("div", { class: "empty",
      text: store.offline
        ? "No tweets cached for this view. Reconnect to load the latest."
        : "No tweets in this window." }));
    return wrap;
  }

  let lastDay = null;
  for (const group of groupThreads(items)) {
    const day = dayLabel(group.at);
    if (day !== lastDay) {
      lastDay = day;
      wrap.appendChild(el("div", { class: "day-label", text: day }));
    }
    wrap.appendChild(group.type === "thread" ? renderThread(group.items) : tweetRow(group.item));
  }

  wrap.appendChild(store.exhausted
    ? el("div", { class: "end-note", text: "That's the last seven days." })
    : el("div", { class: "spinner", id: "feed-sentinel" }));

  return wrap;
}

/* Consecutive posts by one author in one conversation are a thread. Up to three render inline
 * and connected; a longer one shows its opening two and sends the rest to the detail view. */
function renderThread(items) {
  const shown = items.length <= 3 ? items : items.slice(0, 2);
  const out = frag();
  shown.forEach((t, i) => {
    const isLast = i === shown.length - 1;
    const tail = isLast && items.length <= 3;
    out.appendChild(tweetRow(t, { inThread: !tail, threadTail: tail, connector: !tail }));
  });
  if (items.length > 3) {
    out.appendChild(el("article", {
      class: "tweet thread-tail",
      onclick: () => go(`/tweet/${items[0].id}`),
    },
      el("div", { class: "avatar-col" }),
      el("div", { class: "tweet-body" },
        el("span", { class: "show-more", text: `Show this thread (${items.length})` })),
    ));
  }
  return out;
}

function groupThreads(items) {
  const byConversation = new Map();
  for (const t of items) {
    if (!t.conversation_id) continue;
    const key = `${t.conversation_id}|${t.author_handle}`;
    if (!byConversation.has(key)) byConversation.set(key, []);
    byConversation.get(key).push(t);
  }

  const groups = [];
  const consumed = new Set();
  // `items` is newest first, so the first member of a thread we meet is its newest — which is
  // where the whole thread belongs in a reverse-chronological feed.
  for (const t of items) {
    if (consumed.has(t.id)) continue;
    const members = t.conversation_id
      ? byConversation.get(`${t.conversation_id}|${t.author_handle}`) || [t]
      : [t];
    if (members.length < 2) {
      groups.push({ type: "single", item: t, at: t.published_at });
      consumed.add(t.id);
      continue;
    }
    for (const m of members) consumed.add(m.id);
    const ordered = [...members].sort((a, b) => (a.published_at < b.published_at ? -1 : 1));
    groups.push({ type: "thread", items: ordered, at: t.published_at });
  }
  return groups;
}

/* ---------- infinite scroll ---------- */

let observer = null;

export function watchSentinel(root, onExhausted) {
  if (observer) observer.disconnect();
  const sentinel = root.querySelector("#feed-sentinel");
  if (!sentinel) return;
  observer = new IntersectionObserver(async (entries) => {
    if (!entries.some(e => e.isIntersecting)) return;
    if (store.loadingMore || store.exhausted || !store.cursor) return;
    set({ loadingMore: true });
    try {
      const page = await fetchTweets({ cursor: store.cursor });
      set({
        tweets: mergeTweets(store.tweets, page.items),
        cursor: page.cursor,
        exhausted: !page.cursor || !page.items.length,
        loadingMore: false,
      });
      onExhausted();
    } catch {
      // Offline, or the Worker blinked. Stop paging rather than spinning forever; the next
      // scroll to the bottom tries again.
      set({ loadingMore: false, exhausted: true });
      onExhausted();
    }
  }, { rootMargin: "600px" });
  observer.observe(sentinel);
}

export function hydrateFeed(root) {
  hydrateClamps(root);
}
