/* One account's posts.
 *
 * The store only holds posts written by the accounts being polled, so a profile is complete for
 * anyone followed here and empty for anyone else — a reposted stranger, most often. That
 * distinction is why the empty state links out to X instead of only saying there is nothing:
 * there is something, it just was never collected here.
 */

import { el, icon, safeUrl } from "../lib/dom.js";
import * as ICON from "../lib/icons.js";
import { fetchByAuthor } from "../data.js";
import { tweetRow, hydrateClamps, displayName } from "./tweet.js";

export function renderAuthor(handle, onBack) {
  // The bar sits outside .author-view because hydrate replaces that element's contents once the
  // posts land, and a back button that vanishes the moment the page finishes loading is worse
  // than no back button at all.
  return el("div", {},
    el("div", { class: "detail-bar" },
      el("button", { class: "icon-btn", "aria-label": "Back", onclick: onBack }, icon(ICON.BACK, {})),
      el("span", { text: `@${handle}` }),
    ),
    el("div", { class: "author-view", dataset: { handle } },
      el("div", { class: "empty", text: "Loading posts…" })),
  );
}

export async function hydrateAuthor(container, handle) {
  // Callers hand over the main element, not the view inside it — the same contract every other
  // hydrate follows.
  const root = container.querySelector(".author-view");
  if (!root) return;

  let items = [];
  let failed = false;
  try {
    // A week is the Worker's whole retention window, so this is "everything there is".
    items = await fetchByAuthor(handle, { hours: 168, limit: 200 });
  } catch {
    failed = true;
  }
  // The view is replaced on navigation, so a fetch that outlived its own screen has nothing
  // left to fill in.
  if (!root.isConnected || root.dataset.handle !== handle) return;

  const first = items[0];
  const name = displayName(first?.author_name || handle);
  const avatarUrl = safeUrl(first?.author_avatar);

  root.replaceChildren(
    el("header", { class: "author-head" },
      avatarUrl
        ? el("img", { class: "author-avatar", src: avatarUrl, alt: "", loading: "lazy" })
        : el("div", { class: "author-avatar author-avatar-fallback", "aria-hidden": "true",
                      text: String(name).replace(/^@/, "").charAt(0).toUpperCase() }),
      el("div", { class: "author-id" },
        el("div", { class: "author-name", text: name }),
        el("div", { class: "author-handle", text: `@${handle}` }),
      ),
      el("a", { class: "author-out", href: `https://x.com/${encodeURIComponent(handle)}`,
                target: "_blank", rel: "noopener noreferrer", text: "Open on X" }),
    ),
  );

  if (failed) {
    root.appendChild(el("div", { class: "empty",
      text: "Couldn't load these posts. Pull down to retry." }));
    return;
  }

  if (!items.length) {
    root.appendChild(el("div", { class: "empty" },
      el("p", { text: `Nothing from @${handle} in the last 7 days.` }),
      el("p", { class: "empty-note",
                text: "Only accounts followed in StreamWire are collected here — this one may "
                    + "just have been reposted by somebody who is." }),
    ));
    return;
  }

  root.appendChild(el("div", { class: "author-count",
    text: `${items.length} post${items.length === 1 ? "" : "s"} in the last 7 days` }));
  for (const item of items) root.appendChild(tweetRow(item));
  hydrateClamps(root);
}
