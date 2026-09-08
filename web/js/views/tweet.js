/* The tweet row, and everything nested inside it.
 *
 * One renderer serves the feed, a thread, and the detail view, because on Twitter they are the
 * same object at three sizes. Built against docs/design-reference/twitter-feed-gif.png.
 */

import { el, icon, frag, safeUrl } from "../lib/dom.js";
import * as ICON from "../lib/icons.js";
import { shortTime, fullTime, compactCount } from "../lib/time.js";
import * as likes from "../lib/likes.js";
import { go } from "../router.js";
import { openLightbox } from "./lightbox.js";

/* A retweet displays as the post being retweeted — that is what Twitter shows, and it is the
 * post whose text, media and counts matter. The wrapper only supplies the "X reposted" line. */
export function subjectOf(item) {
  if (!item.is_retweet) return item;
  if (item.retweeted) return item.retweeted;
  // A row written before the Worker captured the retweeted post. Twitter's legacy `RT @x: …`
  // string is all we have, so show it under the original author's handle rather than crediting
  // the retweeter with someone else's words.
  return {
    ...item,
    author_handle: item.rt_author || item.author_handle,
    author_name: item.rt_author ? `@${item.rt_author}` : item.author_name,
    author_avatar: null,
    text: String(item.text || "").replace(/^RT @[A-Za-z0-9_]+:\s*/, ""),
  };
}

export function likeIdOf(item) {
  const subject = subjectOf(item);
  return subject.id || item.id;
}

export function tweetRow(item, opts = {}) {
  const { inThread = false, threadTail = false, connector = false } = opts;
  const subject = subjectOf(item);

  const row = el("article", {
    class: `tweet${inThread ? " in-thread" : ""}${threadTail ? " thread-tail" : ""}`,
    onclick: (e) => {
      if (e.target.closest("a, button, video, .quoted, .media-item")) return;
      go(`/tweet/${item.id}`);
    },
  });

  if (item.is_retweet) {
    row.appendChild(el("div", { class: "tweet-context" },
      icon(ICON.RETWEET, {}), `${item.author_name || item.author_handle} reposted`));
  }

  const avatarCol = el("div", { class: "avatar-col" }, avatar(subject));
  if (connector) avatarCol.appendChild(el("div", { class: "thread-line" }));
  row.appendChild(avatarCol);

  row.appendChild(el("div", { class: "tweet-body" },
    nameRow(subject),
    textBlock(subject),
    mediaBlock(subject.media),
    quotedCard(item.quoted || subject.quoted),
    linkCard(subject, !!(subject.media || []).length),
    actionsRow(item, subject),
  ));

  return row;
}

/* ---------- pieces ---------- */

function avatar(subject) {
  const url = safeUrl(subject.author_avatar);
  if (url) {
    const img = el("img", { class: "avatar", src: url, alt: "", loading: "lazy", decoding: "async" });
    // A dead avatar URL would otherwise leave a broken-image glyph in the column.
    img.addEventListener("error", () => img.replaceWith(initials(subject)), { once: true });
    return img;
  }
  return initials(subject);
}

function initials(subject) {
  const name = String(subject.author_name || subject.author_handle || "?").replace(/^@/, "");
  return el("div", { class: "avatar avatar-fallback", "aria-hidden": "true", text: name.charAt(0).toUpperCase() });
}

function nameRow(subject) {
  return el("div", { class: "tweet-head" },
    el("span", { class: "tweet-name", text: displayName(subject.author_name || subject.author_handle) }),
    subject.author_handle ? el("span", { class: "tweet-handle", text: `@${subject.author_handle}` }) : null,
    el("span", { class: "tweet-dot", text: "·" }),
    el("time", { class: "tweet-time", datetime: subject.published_at || "", text: shortTime(subject.published_at) }),
  );
}

/* "Jeff Zrebiec (The Athletic)" -> "Jeff Zrebiec". The outlet is in the config so the digest
 * can attribute properly; on a row it is the thing that pushed the name onto four lines. */
export function displayName(name) {
  return String(name || "").replace(/\s*\(.*$/, "").trim() || String(name || "");
}

/* Twitter renders a tweet's own text with entities linkified and the t.co stub for its card,
 * quote or media removed — the stub is a duplicate of something already on screen. */
function textBlock(subject) {
  const text = stripStubs(subject.text || "");
  if (!text) return null;
  return el("div", { class: "tweet-text clamped" }, ...linkify(text));
}

function stripStubs(text) {
  return text.replace(/\s*https:\/\/t\.co\/\S+/g, "").trim();
}

/* Mentions, hashtags and bare links become accented spans. Built as text nodes and elements,
 * never as markup — the input is someone else's text. */
export function linkify(text) {
  const out = [];
  const pattern = /(https?:\/\/[^\s]+)|(^|[^\w])([@#][A-Za-z0-9_]+)/g;
  let last = 0, match;
  while ((match = pattern.exec(text)) !== null) {
    const [, url, lead, token] = match;
    const start = match.index + (url ? 0 : (lead || "").length);
    if (start > last) out.push(text.slice(last, start));
    if (url) {
      const href = safeUrl(url);
      out.push(href
        ? el("a", { href, target: "_blank", rel: "noopener", text: prettyUrl(url),
                    onclick: (e) => e.stopPropagation() })
        : url);
    } else {
      const href = token.startsWith("@")
        ? `https://x.com/${token.slice(1)}`
        : `https://x.com/hashtag/${token.slice(1)}`;
      out.push(el("a", { href, target: "_blank", rel: "noopener", text: token,
                         onclick: (e) => e.stopPropagation() }));
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "link"; }
}

function prettyUrl(url) {
  try {
    const u = new URL(url);
    const tail = `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
    return tail.length > 34 ? `${tail.slice(0, 33)}…` : tail;
  } catch { return url; }
}

function mediaBlock(media) {
  const items = (media || []).slice(0, 4);
  if (!items.length) return null;
  const wrap = el("div", { class: `media count-${items.length}` });
  // The lightbox is a photo viewer, so it is handed the photos alone — a video's poster is not
  // a picture you can open.
  const photos = items.filter(m => !m.video_url && safeUrl(m.url));
  items.forEach((m) => {
    const cell = el("div", { class: "media-item" });
    // A single item sizes itself to its content, so its box has to be reserved before the
    // content exists. Otherwise the cell is 2:1 until the poster loads and then jumps to the
    // real shape, taking every tweet below it with it — which is how a tap meant for a video
    // lands on the next post instead. The grid layouts are already square in CSS.
    const box = items.length === 1 ? aspectOf(m) : null;
    if (box) {
      cell.style.aspectRatio = String(box);
      cell.classList.add("boxed");
    }

    if (m.video_url && safeUrl(m.video_url)) {
      const gif = !!m.loop;
      const video = el("video", {
        src: safeUrl(m.video_url),
        poster: safeUrl(m.url) || null,
        playsinline: true,
        preload: "none",
        ...(gif ? { autoplay: true, muted: true, loop: true } : { controls: true }),
      });
      // Autoplay is refused unless muted is set as a property before the source loads.
      if (gif) video.muted = true;
      else warmVideo(video);
      cell.appendChild(video);
      if (gif) cell.appendChild(el("span", { class: "media-badge", text: "GIF" }));
    } else if (safeUrl(m.url)) {
      cell.appendChild(el("img", { src: safeUrl(m.url), alt: "", loading: "lazy", decoding: "async" }));
      cell.addEventListener("click", (e) => {
        e.stopPropagation();
        openLightbox(photos.map(x => safeUrl(x.url)), photos.indexOf(m));
      });
    }
    wrap.appendChild(cell);
  });
  return wrap;
}

/* Width over height, from whatever the Worker recorded, falling back to the size Twitter
 * writes into the mp4's own path for rows stored before it did. Clamped at both ends: a
 * phone-shot vertical clip would otherwise be two screens tall, and a panorama a sliver. */
function aspectOf(m) {
  let w = Number(m.w) || 0, h = Number(m.h) || 0;
  if (!(w > 0 && h > 0)) {
    const hit = /\/(\d{2,4})x(\d{2,4})\//.exec(String(m.video_url || ""));
    if (hit) { w = Number(hit[1]); h = Number(hit[2]); }
  }
  if (!(w > 0 && h > 0)) return null;
  return Math.min(Math.max(w / h, 0.75), 2);
}

/* `preload="none"` is why a tap on a video sat there: nothing at all had been fetched, so the
 * player had to open a connection and read the file header before it could start. Videos that
 * come near the screen are promoted to `metadata` — a few kilobytes, and enough that play is
 * immediate — while the rest stay cold, so opening a feed with forty clips in it doesn't fetch
 * forty headers at once. */
let videoWatcher = null;
function warmVideo(video) {
  if (!("IntersectionObserver" in window)) { video.preload = "metadata"; return; }
  if (!videoWatcher) {
    videoWatcher = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        videoWatcher.unobserve(e.target);
        e.target.preload = "metadata";
        // Safari will not act on a changed preload on its own; load() asks for the header now.
        // Safe only while nothing has been fetched — it would restart a playing video.
        if (e.target.readyState === 0) { try { e.target.load(); } catch { /* not ready */ } }
      }
    }, { rootMargin: "400px" });
  }
  videoWatcher.observe(video);
}

/* The quoted post: its own tappable card. One image renders as a square thumbnail beside the
 * text rather than full width — see docs/design-reference/twitter-feed-showmore.png. */
function quotedCard(quoted) {
  if (!quoted) return null;
  const card = el("div", { class: "quoted" });
  if (quoted.id) {
    card.addEventListener("click", (e) => {
      if (e.target.closest("a, video")) return;
      e.stopPropagation();
      go(`/tweet/${quoted.id}`);
    });
  }

  card.appendChild(el("div", { class: "quoted-head" },
    safeUrl(quoted.author_avatar)
      ? el("img", { class: "quoted-avatar", src: safeUrl(quoted.author_avatar), alt: "", loading: "lazy" })
      : null,
    el("span", { class: "quoted-name", text: displayName(quoted.author_name || quoted.author_handle) }),
    quoted.author_handle ? el("span", { class: "quoted-handle", text: `@${quoted.author_handle}` }) : null,
    el("span", { class: "tweet-dot", text: "·" }),
    el("span", { class: "tweet-time", text: shortTime(quoted.published_at) }),
  ));

  const text = stripStubs(quoted.text || "");
  const media = quoted.media || [];
  const singlePhoto = media.length === 1 && !media[0].video_url && safeUrl(media[0].url);

  if (singlePhoto && text) {
    card.appendChild(el("div", { class: "quoted-inline" },
      el("img", { class: "quoted-thumb", src: singlePhoto, alt: "", loading: "lazy" }),
      el("div", { class: "quoted-text clamped" }, ...linkify(text)),
    ));
  } else {
    if (text) card.appendChild(el("div", { class: "quoted-text clamped" }, ...linkify(text)));
    if (media.length) card.appendChild(mediaBlock(media));
  }
  return card;
}

/* Every outbound link stays reachable whether or not a preview was ever built for it. A
 * quarter of them never resolve — Substack and the Advance papers turn the fetch away, some
 * pages carry no Open Graph tags at all — and by the time the row renders, the tweet's own
 * text has had its t.co stub removed. Without a card of some kind the link is simply gone. */
function linkCard(subject, compact) {
  const card = subject.link_card || null;
  const href = safeUrl(card && card.url) || safeUrl((subject.links || [])[0]);
  if (!href) return null;
  const image = card ? safeUrl(card.image) : null;
  const title = (card && card.title) || prettyUrl(href);
  // Three shapes: full width with the image on top, a thumbnail beside the text when the tweet
  // already carries media of its own, and text alone when there is no image to show. The last
  // one has to skip the thumbnail column, or the headline is squeezed into what's left of it.
  const shape = !image ? " bare" : compact ? " compact" : "";
  const node = el("a", {
    class: `link-card${shape}`,
    href, target: "_blank", rel: "noopener",
    onclick: (e) => e.stopPropagation(),
  },
    image ? el("img", { src: image, alt: "", loading: "lazy", decoding: "async" }) : null,
    el("div", { class: "link-card-body" },
      el("div", { class: "link-card-domain", text: `From ${(card && card.domain) || hostOf(href)}` }),
      title ? el("div", { class: "link-card-title", text: title }) : null,
    ),
  );
  // A hotlink-protected or expired image would otherwise render as a broken-image glyph in a
  // box. Drop it and let the card stand on its headline.
  const img = node.querySelector("img");
  if (img) img.addEventListener("error", () => {
    img.remove();
    node.classList.remove("compact");
    node.classList.add("bare");
  }, { once: true });
  return node;
}

/* Counts are a snapshot from when the tweet was fetched and never change, so only the heart is
 * a control. The rest are read-outs, and the X icon is the way out to the real post. */
function actionsRow(item, subject) {
  const id = likeIdOf(item);
  const liked = likes.has(id);

  const stat = (paths, value, label) => el("span", { class: "action", "aria-label": label },
    icon(paths, {}), value ? el("span", { text: value }) : null);

  const heart = el("button", {
    class: `action${liked ? " is-liked" : ""}`,
    "aria-pressed": String(liked),
    "aria-label": "Like",
    onclick: (e) => {
      e.stopPropagation();
      const now = likes.toggle(id, subject);
      heart.classList.toggle("is-liked", now);
      heart.setAttribute("aria-pressed", String(now));
      if (now) {
        heart.classList.add("just-liked");
        setTimeout(() => heart.classList.remove("just-liked"), 320);
      }
      const n = heart.querySelector(".like-count");
      const base = Number(subject.like_count || 0);
      if (n) n.textContent = compactCount(base + (now ? 1 : 0));
    },
  }, icon(ICON.HEART, {}),
     el("span", { class: "like-count", text: compactCount(Number(subject.like_count || 0) + (liked ? 1 : 0)) }));

  const xHref = safeUrl(subject.url) || safeUrl(item.url);

  return el("div", { class: "actions" },
    stat(ICON.REPLY, compactCount(subject.reply_count), "Replies"),
    stat(ICON.RETWEET, compactCount(subject.retweet_count), "Reposts"),
    heart,
    stat(ICON.VIEWS, compactCount(subject.view_count), "Views"),
    xHref ? el("a", {
      class: "action x-link", href: xHref, target: "_blank", rel: "noopener",
      "aria-label": "Open on X", onclick: (e) => e.stopPropagation(),
    }, icon(ICON.X_LOGO, {})) : null,
  );
}

/* ---------- detail ---------- */

export function tweetDetail(item) {
  const subject = subjectOf(item);

  const body = el("div", { class: "detail" });

  if (item.is_retweet) {
    body.appendChild(el("div", { class: "tweet-context", style: "margin-left:0" },
      icon(ICON.RETWEET, {}), `${item.author_name || item.author_handle} reposted`));
  }

  body.appendChild(el("div", { class: "detail-head" },
    avatar(subject),
    el("div", { class: "detail-names" },
      el("div", { class: "detail-name", text: displayName(subject.author_name || subject.author_handle) }),
      subject.author_handle ? el("div", { class: "detail-handle", text: `@${subject.author_handle}` }) : null,
    ),
  ));

  const text = stripStubs(subject.text || "");
  if (text) body.appendChild(el("div", { class: "detail-text" }, ...linkify(text)));

  const media = mediaBlock(subject.media);
  if (media) body.appendChild(media);
  const quoted = quotedCard(item.quoted || subject.quoted);
  if (quoted) body.appendChild(quoted);
  const card = linkCard(subject, false);
  if (card) body.appendChild(card);

  const views = compactCount(subject.view_count);
  body.appendChild(el("div", { class: "detail-meta" },
    fullTime(subject.published_at),
    views ? frag(" · ", el("b", { text: views }), " Views") : null,
  ));

  body.appendChild(actionsRow(item, subject));
  return body;
}

/* ---------- clamping ---------- */

/* "Show more" only appears where the text is actually cut off, which can only be measured once
 * the element is laid out. Run after a render. */
export function hydrateClamps(root) {
  for (const node of root.querySelectorAll(".tweet-text.clamped, .quoted-text.clamped")) {
    if (node.dataset.checked) continue;
    node.dataset.checked = "1";
    if (node.scrollHeight <= node.clientHeight + 2) {
      node.classList.remove("clamped");
      continue;
    }
    const more = el("button", {
      class: "show-more", text: "Show more",
      onclick: (e) => { e.stopPropagation(); node.classList.remove("clamped"); more.remove(); },
    });
    // Insert after the grid, not after the text inside it, or the button becomes a grid cell
    // in the thumbnail's narrow column.
    (node.closest(".quoted-inline") || node).after(more);
  }
}
