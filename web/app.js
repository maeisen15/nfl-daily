/* NFL Daily — app logic. Static PWA reading ./data/*.json */

const state = {
  config: null, feed: null, digest: null,
  scope: null,
  tab: "home",
};

const $ = (sel) => document.querySelector(sel);

/* ---------- theme (system default, manual override persisted) ---------- */

const SUN = "M12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0-5.5 1.2 3.1-1.2.5-1.2-.5L12 1.5zm0 21-1.2-3.1 1.2-.5 1.2.5L12 22.5zM1.5 12l3.1-1.2.5 1.2-.5 1.2L1.5 12zm21 0-3.1 1.2-.5-1.2.5-1.2 3.1 1.2zM4.6 4.6l3 1.3-.8 1-2.2-2.3zm14.8 14.8-3-1.3.8-1 2.2 2.3zM19.4 4.6l-1.3 3-1-.8 2.3-2.2zM4.6 19.4l1.3-3 1 .8-2.3 2.2z";
const MOON = "M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5 8.5 8.5 0 1 0 20.5 14.5z";

function applyTheme(choice) {
  if (choice === "light" || choice === "dark") {
    document.documentElement.dataset.theme = choice;
  } else {
    delete document.documentElement.dataset.theme;
  }
  const dark = document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme &&
     window.matchMedia("(prefers-color-scheme: dark)").matches);
  const icon = $("#themeIcon");
  if (icon) icon.setAttribute("d", dark ? SUN : MOON);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? "#0E0D13" : "#F5F4F8";
}

function initTheme() {
  const params = new URLSearchParams(location.search);
  applyTheme(params.get("theme") || localStorage.getItem("theme") || "auto");
  $("#themeBtn").onclick = () => {
    const dark = document.documentElement.dataset.theme === "dark" ||
      (!document.documentElement.dataset.theme &&
       window.matchMedia("(prefers-color-scheme: dark)").matches);
    const next = dark ? "light" : "dark";
    localStorage.setItem("theme", next);
    applyTheme(next);
  };
  window.matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => applyTheme(localStorage.getItem("theme") || "auto"));
}

initTheme();
init();

async function init() {
  try {
    const bust = `?v=${Date.now()}`;
    const [config, feed, digest] = await Promise.all([
      fetch(`data/config.json${bust}`).then(r => r.json()),
      fetch(`data/feed.json${bust}`).then(r => r.json()),
      fetch(`data/digest.json${bust}`).then(r => r.json()),
    ]);
    state.config = config;
    state.feed = feed;
    state.digest = digest;
  } catch (err) {
    $("#main").innerHTML = `<div class="empty">Couldn't load the feed. Check your connection and pull to refresh.</div>`;
    return;
  }
  const params = new URLSearchParams(location.search);
  const saved = params.get("scope") || localStorage.getItem("scope");
  const codes = state.config.scopes.map(s => s.code);
  state.scope = codes.includes(saved) ? saved : state.config.default_scope;
  if (["home", "tweets", "articles"].includes(params.get("tab"))) {
    state.tab = params.get("tab");
    document.querySelectorAll(".tab").forEach(b =>
      b.classList.toggle("is-active", b.dataset.tab === state.tab));
  }

  renderScopes();
  renderUpdated();
  bindTabs();
  renderView();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

/* ---------- chrome ---------- */

function renderScopes() {
  const nav = $("#scopes");
  nav.innerHTML = "";
  for (const s of state.config.scopes) {
    const btn = document.createElement("button");
    btn.className = "scope" + (s.code === state.scope ? " is-active" : "");
    btn.textContent = s.short || s.label;
    btn.onclick = () => {
      state.scope = s.code;
      localStorage.setItem("scope", s.code);
      renderScopes();
      renderView();
    };
    nav.appendChild(btn);
  }
  document.documentElement.dataset.scope = state.scope;
}

function renderUpdated() {
  const dt = new Date(state.feed.generated_at);
  $("#updated").textContent = isNaN(dt) ? "" : `Updated ${relTime(dt)}`;
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.onclick = () => {
      state.tab = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach(b => b.classList.toggle("is-active", b === btn));
      renderView();
      window.scrollTo(0, 0);
    };
  });
}

function renderView() {
  document.documentElement.dataset.scope = state.scope;
  for (const name of ["home", "tweets", "articles"]) {
    const el = $(`#view-${name}`);
    el.hidden = name !== state.tab;
    if (name === state.tab) el.replaceChildren(...render[name]());
  }
}

/* ---------- renderers ---------- */

const render = {
  home() {
    const tab = state.digest.tabs.find(t => t.scope === state.scope);
    if (!tab) return [empty("No digest for this view yet. It'll appear after the next run.")];
    return digestSections(tab.markdown);
  },

  tweets() {
    const items = scoped("tweet");
    if (!items.length) return [empty("No tweets in this window.")];
    return withDayLabels(items, t => {
      // Deliberately a div, not a link: the card holds interactive content (video controls,
      // a quoted post with its own link), so a tap anywhere must not navigate off to X.
      // Leaving is an explicit choice via the "Open on X" action below.
      const d = document.createElement("div");
      d.className = "card tweet-card";
      d.innerHTML = `
        <div class="card-meta">
          <span class="src">${esc(t.author_name || t.source_name || "")}</span>
          <span class="handle">@${esc(t.author_handle || "")}</span>
          <span class="when">${relTime(new Date(t.published_at))}</span>
        </div>
        <div class="tweet-text">${esc(cleanTweet(t.text || ""))}</div>
        ${tweetMedia(t.media)}
        ${quotedTweet(t.quoted)}
        <div class="card-actions">${xLink(t.url, "Open on X")}</div>`;
      return d;
    });
  },

  articles() {
    const items = scoped("article");
    if (!items.length) return [empty("No articles in this window.")];
    return withDayLabels(items, r => {
      const a = card(r.url);
      a.innerHTML = `
        <div class="card-meta">
          <span class="src">${esc(r.source_name || "")}</span>
          <span class="when">${relTime(new Date(r.published_at))}</span>
        </div>
        <div class="article-title">${esc(r.title || "")}</div>
        ${r.text ? `<div class="article-snippet">${esc(r.text)}</div>` : ""}`;
      return a;
    });
  },
};

function scoped(type) {
  return state.feed.items.filter(i => i.type === type && i.scopes.includes(state.scope));
}

function card(url) {
  const a = document.createElement("a");
  a.className = "card";
  // Only http(s) hrefs — neutralize a javascript:/data: URL from a hijacked feed (an anchor
  // executes javascript: hrefs on tap regardless of target="_blank").
  a.href = /^https?:\/\//i.test(url || "") ? url : "#";
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function empty(msg) {
  const d = document.createElement("div");
  d.className = "empty";
  d.textContent = msg;
  return d;
}

function withDayLabels(items, toCard) {
  const out = [];
  let lastDay = null;
  for (const it of items) {
    const day = dayLabel(new Date(it.published_at));
    if (day !== lastDay) {
      lastDay = day;
      const lbl = document.createElement("div");
      lbl.className = "day-label";
      lbl.textContent = day;
      out.push(lbl);
    }
    out.push(toCard(it));
  }
  return out;
}

/* ---------- digest markdown (headers, bullets, links, bold/italic) ---------- */

function digestSections(md) {
  const sections = [];
  let current = null;
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("# ")) continue; // page title — masthead covers it
    const h = line.match(/^##\s+(.*)/);
    if (h) {
      current = { title: h[1].trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  const out = [];
  for (const s of sections) {
    const sec = document.createElement("div");
    sec.className = "digest-section";
    sec.innerHTML = `<h2>${esc(s.title)}</h2>${mdBlock(s.lines)}`;
    if (/source health/i.test(s.title)) {
      const det = document.createElement("details");
      det.className = "source-health";
      det.innerHTML = `<summary>Source health</summary>`;
      det.appendChild(sec);
      out.push(det);
    } else {
      out.push(sec);
    }
  }
  return out.length ? out : [empty("Digest is empty for this window.")];
}

function mdBlock(lines) {
  let html = "", inList = false;
  for (const line of lines) {
    const li = line.match(/^\s*[-*]\s+(.*)/);
    if (li) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${mdInline(li[1])}</li>`;
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      if (line.trim() && line.trim() !== "---") html += `<p>${mdInline(line.trim())}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}

function mdInline(text) {
  let s = esc(text);
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, `<a href="$2" target="_blank" rel="noopener">$1</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|\s)_([^_]+)_/g, "$1<em>$2</em>");
  return s;
}

/* ---------- utils ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function tweetMedia(media) {
  if (!media || !media.length) return "";
  const items = media.slice(0, 4).map(m => {
    if (m.video_url) {
      // Native Twitter video/GIF — plays inline in iOS WebKit. GIFs autoplay muted+loop;
      // regular video is tap-to-play with controls to respect cellular data.
      const gif = !!m.loop;
      return `<div class="tweet-media-item">
        <video src="${esc(m.video_url)}" ${m.url ? `poster="${esc(m.url)}"` : ""}
          playsinline preload="none" ${gif ? "autoplay muted loop" : "controls"}></video>
        ${gif ? `<span class="media-badge">GIF</span>` : ""}
      </div>`;
    }
    return `<div class="tweet-media-item">
      <img src="${esc(m.url)}" alt="" loading="lazy">
    </div>`;
  }).join("");
  return `<div class="tweet-media ${media.length > 1 ? "grid" : ""}">${items}</div>`;
}

function quotedTweet(q) {
  // A quoted post renders as a nested card with its own text and media, so the whole point
  // of the quote is readable without a trip to X. Its video plays inline like any other.
  if (!q) return "";
  const when = q.published_at ? relTime(new Date(q.published_at)) : "";
  return `<div class="quoted">
    <div class="card-meta">
      <span class="q-name">${esc(q.author_name || "")}</span>
      <span class="handle">@${esc(q.author_handle || "")}</span>
      ${when ? `<span class="when">${esc(when)}</span>` : ""}
    </div>
    ${q.text ? `<div class="tweet-text">${esc(cleanTweet(q.text))}</div>` : ""}
    ${tweetMedia(q.media)}
    ${q.url ? `<div class="card-actions">${xLink(q.url, "Open quoted post")}</div>` : ""}
  </div>`;
}

function xLink(url, label) {
  // Same http(s)-only guard as card(): an anchor runs a javascript: href on tap.
  if (!/^https?:\/\//i.test(url || "")) return "";
  return `<a class="x-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} ↗</a>`;
}

function cleanTweet(text) {
  // t.co stubs stand in for attached media/quotes we don't render yet
  return text.replace(/\s*https:\/\/t\.co\/\S+/g, "").trim();
}

function relTime(dt) {
  if (isNaN(dt)) return "";
  const mins = Math.round((Date.now() - dt.getTime()) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function dayLabel(dt) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(dt); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  return dt.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}
