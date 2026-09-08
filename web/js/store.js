/* App state and the subscriptions that redraw on it. Small enough to be a plain object with a
 * listener list — the reactivity a framework would add would be spent on four fields. */

import * as likes from "./lib/likes.js";

const listeners = new Set();

export const store = {
  scope: null,
  theme: "light",

  tweets: [],          // everything loaded so far, newest first
  cursor: null,        // the Worker's continuation token, null when the window is exhausted
  loadingMore: false,
  exhausted: false,

  pending: [],         // fetched but held back, so the feed never shifts under a thumb
  newestSeen: null,

  offline: false,
  scrollPositions: {}, // route key -> scrollY, so Back returns to where you were
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) fn();
}

export function set(patch) {
  Object.assign(store, patch);
  emit();
}

/* Tweets arrive from several places — the first load, a background poll, a page of scrollback —
 * and the search index can hand back a tweet twice. Merge on id and keep newest first. */
export function mergeTweets(existing, incoming) {
  const seen = new Set(existing.map(t => t.id));
  const merged = existing.concat(incoming.filter(t => !seen.has(t.id)));
  merged.sort((a, b) => (a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : 0));
  return merged;
}

export function tweetsForScope(scope) {
  return store.tweets.filter(t => (t.scopes || []).includes(scope));
}

export function pendingForScope(scope) {
  return store.pending.filter(t => (t.scopes || []).includes(scope));
}

export function findTweet(id) {
  return store.tweets.find(t => t.id === id)
      || store.pending.find(t => t.id === id)
      || (likes.all().find(e => e.id === id) || {}).tweet
      || null;
}

/* Every tweet stored in the same conversation, oldest first — the thread, as far as we hold it.
 * Only tweets from tracked handles are stored, and replies to other people are never ingested,
 * so a conversation here is always one author talking to themselves. */
export function threadFor(tweet) {
  if (!tweet || !tweet.conversation_id) return [];
  return store.tweets
    .filter(t => t.conversation_id === tweet.conversation_id && t.author_handle === tweet.author_handle)
    .sort((a, b) => (a.published_at < b.published_at ? -1 : 1));
}
