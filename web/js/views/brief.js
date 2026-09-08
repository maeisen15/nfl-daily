/* The daily brief. The pipeline writes markdown; this renders it as DOM.
 *
 * A deliberately small subset — headings, bullets, links, bold, italic — because that is all
 * the digest prompt emits, and a general markdown parser would be a much larger attack surface
 * for a document assembled from other people's headlines.
 */

import { el, safeUrl } from "../lib/dom.js";
import { digestFor, state } from "../data.js";
import { renderDossier } from "./dossier.js";

export function renderBrief(scope) {
  const markdown = digestFor(scope);
  const wrap = el("div");

  // The game-week dossier leads the Ravens brief: it is current to the hour, where the written
  // summary below it is a day old by design.
  const dossier = renderDossier(scope);
  if (dossier) wrap.appendChild(dossier);

  if (!markdown) {
    wrap.appendChild(el("div", { class: "empty",
      text: dossier
        ? "The written brief is added once a day."
        : "No brief for this view yet. It's written once a day." }));
    return wrap;
  }

  for (const section of parseSections(markdown)) {
    // Source Health is fetch diagnostics. The prompt no longer emits it, but a digest written
    // before that change still carries one, and it must never reach the reader either way.
    if (/source\s*health/i.test(section.title)) continue;
    const node = el("section", { class: "digest-section" }, el("h2", { text: section.title }));
    let list = null;
    for (const line of section.lines) {
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (bullet) {
        if (!list) { list = el("ul"); node.appendChild(list); }
        list.appendChild(el("li", {}, ...inline(bullet[1])));
      } else if (line.trim() && line.trim() !== "---") {
        list = null;
        node.appendChild(el("p", {}, ...inline(line.trim())));
      }
    }
    wrap.appendChild(node);
  }

  const stamp = state.digest?.generated_at;
  if (stamp) {
    const dt = new Date(stamp);
    if (!isNaN(dt)) {
      wrap.appendChild(el("div", { class: "digest-stamp",
        text: `Written ${dt.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}` }));
    }
  }
  return wrap;
}

function parseSections(markdown) {
  const sections = [];
  let current = null;
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("# ")) continue;         // the page title; the masthead already says it
    const heading = line.match(/^##\s+(.*)$/);
    if (heading) {
      current = { title: heading[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections;
}

/* [text](url), **bold**, _italic_ — as elements, never as markup. */
function inline(text) {
  const out = [];
  const pattern = /\[([^\]]+)\]\((https?:[^)\s]+)\)|\*\*([^*]+)\*\*|(?:^|(?<=\s))_([^_]+)_/g;
  let last = 0, match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const [, linkText, href, bold, italic] = match;
    if (href && safeUrl(href)) {
      out.push(el("a", { href, target: "_blank", rel: "noopener", text: linkText }));
    } else if (href) {
      out.push(linkText);
    } else if (bold) {
      out.push(el("strong", { text: bold }));
    } else if (italic) {
      out.push(el("em", { text: italic }));
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
