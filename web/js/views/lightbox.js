/* Full-screen image viewer. Tapping a photo in the feed opens it here, which is the gesture
 * Twitter trains — and the only way to actually read a screenshot of a depth chart. */

import { el, icon } from "../lib/dom.js";
import * as ICON from "../lib/icons.js";

let open = null;

export function openLightbox(urls, index = 0) {
  if (open) closeLightbox();
  const src = urls[index];
  if (!src) return;

  const box = el("div", { class: "lightbox", role: "dialog", "aria-modal": "true" },
    el("img", { src, alt: "" }),
    el("button", { class: "lightbox-close", "aria-label": "Close", onclick: closeLightbox }, icon(ICON.CLOSE, {})),
  );
  box.addEventListener("click", (e) => { if (e.target === box) closeLightbox(); });

  // The viewer is modal, so Back should dismiss it rather than leaving the page underneath it.
  history.pushState({ lightbox: true }, "");
  window.addEventListener("popstate", onPop);
  document.body.appendChild(box);
  open = box;
}

function onPop() {
  if (open) { open.remove(); open = null; }
  window.removeEventListener("popstate", onPop);
}

export function closeLightbox() {
  if (!open) return;
  open.remove();
  open = null;
  window.removeEventListener("popstate", onPop);
  if (history.state && history.state.lightbox) history.back();
}
