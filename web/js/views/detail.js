/* One tweet, full size, with its thread beneath it. */

import { el, icon, frag } from "../lib/dom.js";
import * as ICON from "../lib/icons.js";
import { store, findTweet, threadFor } from "../store.js";
import { tweetDetail, tweetRow, hydrateClamps } from "./tweet.js";

export function renderDetail(id, onBack) {
  const wrap = el("div");
  wrap.appendChild(el("div", { class: "detail-bar" },
    el("button", { class: "icon-btn", "aria-label": "Back", onclick: onBack }, icon(ICON.BACK, {})),
    el("span", { text: "Post" }),
  ));

  const tweet = findTweet(id);
  if (!tweet) {
    wrap.appendChild(el("div", { class: "empty",
      text: "That post isn't loaded. It may have aged out of the seven-day window." }));
    return wrap;
  }

  wrap.appendChild(tweetDetail(tweet));

  // The rest of the thread, oldest first, excluding the tweet already shown above.
  const thread = threadFor(tweet).filter(t => t.id !== tweet.id);
  if (thread.length) {
    wrap.appendChild(el("div", { class: "thread-heading", text: "Thread" }));
    const rest = frag();
    thread.forEach((t, i) => {
      const last = i === thread.length - 1;
      rest.appendChild(tweetRow(t, { inThread: !last, threadTail: last, connector: !last }));
    });
    wrap.appendChild(rest);
  }
  return wrap;
}

export function hydrateDetail(root) {
  hydrateClamps(root);
}
