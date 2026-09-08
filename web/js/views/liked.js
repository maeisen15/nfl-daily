/* Liked tweets — the save-for-later list. Ordered by when they were liked, not by when they
 * were posted: this is a pile of things set aside, and the most recently set aside is the one
 * being looked for. */

import { el } from "../lib/dom.js";
import { tweetRow, hydrateClamps } from "./tweet.js";
import * as likes from "../lib/likes.js";

export function renderLiked() {
  const entries = likes.all();
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "section-head" },
    el("h2", { text: "Liked" }),
    el("a", { href: "#/tweets", text: "Back to feed" }),
  ));

  if (!entries.length) {
    wrap.appendChild(el("div", { class: "empty",
      text: "Nothing liked yet. Tap the heart on a post to keep it here." }));
    return wrap;
  }

  for (const entry of entries) {
    // A stored like is the post as it was displayed, so it renders through the same row as the
    // feed even long after the Worker pruned the original.
    wrap.appendChild(tweetRow({ ...entry.tweet, id: entry.id }));
  }
  return wrap;
}

export function hydrateLiked(root) {
  hydrateClamps(root);
}
