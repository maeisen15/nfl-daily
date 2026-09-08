/* Element construction. Views build DOM rather than HTML strings — the old renderer
 * concatenated markup and escaped by hand, which is both an XSS surface and the reason the
 * layout was hard to follow. A text node cannot be an injection. */

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? "" : v);
    }
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/* SVG has to be built in its own namespace; createElement("svg") produces an inert HTML
 * element that renders as nothing. */
export function icon(paths, opts = {}) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", opts.viewBox || "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const d of [].concat(paths)) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/* Only http(s) survives. An anchor runs a `javascript:` href on tap regardless of target, so a
 * hijacked feed must never reach one. */
export function safeUrl(url) {
  return /^https?:\/\//i.test(url || "") ? url : null;
}
