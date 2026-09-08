/* The articles list.
 *
 * A thumbnail row rather than a headline list, because the picture is what makes it possible
 * to glance at eighty items and see the one worth reading. Duplicates across outlets are
 * already collapsed by the pipeline; `cluster_size` is how many merged, which is the app's
 * importance signal.
 */

import { el, safeUrl } from "../lib/dom.js";
import { dayLabel, shortTime } from "../lib/time.js";
import { articles, state } from "../data.js";

export function renderArticles(scope) {
  const items = sortArticles(articles(scope), scope);
  const wrap = el("div");
  if (!items.length) {
    wrap.appendChild(el("div", { class: "empty", text: "No articles in this window." }));
    return wrap;
  }

  let lastDay = null;
  for (const item of items) {
    const day = dayLabel(item.published_at);
    if (day !== lastDay) {
      lastDay = day;
      wrap.appendChild(el("div", { class: "day-label", text: day }));
    }
    wrap.appendChild(articleRow(item));
  }
  return wrap;
}

function articleRow(item) {
  const image = safeUrl((item.media || [])[0]?.url);
  const row = el("a", {
    class: `article${image ? "" : " no-image"}`,
    href: safeUrl(item.url) || "#",
    target: "_blank", rel: "noopener",
  },
    el("div", {},
      el("div", { class: "article-source",
                  text: `${item.source_name || ""} · ${shortTime(item.published_at)}` }),
      el("div", { class: "article-title", text: item.title || "" }),
      item.text ? el("div", { class: "article-snippet", text: item.text }) : null,
    ),
    image ? el("img", { class: "article-thumb", src: image, alt: "", loading: "lazy", decoding: "async" }) : null,
  );
  // A dead image URL collapses the row to its text form rather than showing a broken glyph.
  const img = row.querySelector("img");
  if (img) img.addEventListener("error", () => {
    img.remove();
    row.classList.add("no-image");
  }, { once: true });
  return row;
}

/* Day boundaries win everywhere — a two-day-old piece above today's news is what makes the tab
 * feel dead. Within a day, the team scope trusts the outlet and the league scopes trust the
 * number of outlets that ran the story. */
function sortArticles(items, scope) {
  const role = (state.config?.scopes || []).find(s => s.code === scope)?.role;
  const byOutlet = role === "primary";
  return [...items].sort((a, b) => {
    const dayDiff = dayKey(b.published_at) - dayKey(a.published_at);
    if (dayDiff) return dayDiff;
    if (byOutlet) {
      const rank = (a.source_rank ?? 99) - (b.source_rank ?? 99);
      if (rank) return rank;
    } else {
      const size = (b.cluster_size ?? 1) - (a.cluster_size ?? 1);
      if (size) return size;
    }
    return a.published_at < b.published_at ? 1 : -1;
  });
}

function dayKey(iso) {
  const dt = new Date(iso);
  if (isNaN(dt)) return 0;
  dt.setHours(0, 0, 0, 0);
  return dt.getTime();
}
