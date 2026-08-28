/* NFL Daily — app logic. Static PWA reading ./data/*.json */

const state = {
  config: null, feed: null, digest: null,
  scope: null,
  tab: "home",
  liveTweets: null,      // from the Worker; null until loaded, [] if it had none
  tweetsStale: false,    // true when we fell back to the tweets baked into feed.json
  authorFilter: new Set(),
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

  // Tweets arrive live from the Worker, so they're fetched separately and the first paint
  // isn't blocked on them. Until this resolves the app shows the tweets baked into feed.json.
  loadLiveTweets().then(() => {
    renderUpdated();
    if (state.tab === "tweets") renderView();
  });

  // Coming back to the app after a while should show what happened while it was closed.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
}

async function loadLiveTweets() {
  const base = (state.config && state.config.tweets_url) || "";
  if (!base) { state.tweetsStale = true; return; }
  try {
    const res = await fetch(`${base}/tweets?hours=48&limit=500`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    state.liveTweets = Array.isArray(body.items) ? body.items : [];
    state.tweetsStale = false;
  } catch {
    // Worker unreachable or offline: keep whatever feed.json carried rather than blanking
    // the tab, and say so in the header.
    state.tweetsStale = true;
  }
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    await loadLiveTweets();
    renderUpdated();
    if (state.tab === "tweets") renderView();
  } finally {
    refreshing = false;
  }
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
      state.authorFilter.clear();   // an author chip from the Ravens tab means nothing on NFL
      renderScopes();
      renderUpdated();
      renderView();
    };
    nav.appendChild(btn);
  }
  document.documentElement.dataset.scope = state.scope;
}

function renderUpdated() {
  // On the Tweets tab the number that matters is how old the newest tweet is, not when the
  // article pipeline last ran.
  let dt = new Date(state.feed.generated_at);
  if (state.tab === "tweets" && state.liveTweets && state.liveTweets.length) {
    const newest = new Date(state.liveTweets[0].published_at);
    if (!isNaN(newest)) dt = newest;
  }
  const suffix = state.tweetsStale && state.tab === "tweets" ? " · offline" : "";
  $("#updated").textContent = isNaN(dt) ? "" : `Updated ${relTime(dt)}${suffix}`;
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.onclick = () => {
      state.tab = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach(b => b.classList.toggle("is-active", b === btn));
      renderUpdated();
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
    const all = tweetsForScope();
    if (!all.length) {
      return [empty(state.tweetsStale
        ? "No tweets cached for this view. Reconnect to load the latest."
        : "No tweets in this window.")];
    }

    // Filter chips are built from everyone present in this scope, so the counts stay honest
    // even when a filter is active.
    const chips = authorChips(all);
    const items = state.authorFilter.size
      ? all.filter(t => state.authorFilter.has(t.author_handle))
      : all;

    if (!items.length) return [chips, empty("No tweets from the selected accounts.")];

    return [chips, ...withDayLabels(items, t => {
      // Deliberately a div, not a link: the card holds interactive content (video controls,
      // a quoted post with its own link), so a tap anywhere must not navigate off to X.
      // Leaving is an explicit choice via the "Open on X" action below.
      const d = document.createElement("div");
      d.className = "card tweet-card";
      const badge = t.is_retweet
        ? `<span class="tag tag-rt">RT${t.rt_author ? ` @${esc(t.rt_author)}` : ""}</span>`
        : (t.is_self_thread ? `<span class="tag tag-thread">thread</span>` : "");
      d.innerHTML = `
        <div class="card-meta">
          <span class="src">${esc(t.author_name || t.source_name || "")}</span>
          <span class="handle">@${esc(t.author_handle || "")}</span>
          ${badge}
          <span class="when">${relTime(new Date(t.published_at))}</span>
        </div>
        <div class="tweet-text">${esc(cleanTweet(t.text || ""))}</div>
        ${tweetMedia(t.media)}
        ${quotedTweet(t.quoted)}
        <div class="card-actions">${xLink(t.url, "Open on X")}</div>`;
      return d;
    })];
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

/* Live tweets from the Worker when we have them, otherwise whatever the last pipeline run
 * baked into feed.json. The two carry the same fields, so nothing downstream cares which. */
function tweetsForScope() {
  const live = state.liveTweets;
  const items = live && live.length ? live : scoped("tweet");
  return items
    .filter(t => (t.scopes || []).includes(state.scope))
    .sort((a, b) => (a.published_at < b.published_at ? 1 : -1));
}

function authorChips(items) {
  const counts = new Map();
  for (const t of items) {
    const handle = t.author_handle || "";
    if (!handle) continue;
    const entry = counts.get(handle) || { name: t.author_name || handle, n: 0 };
    entry.n++;
    counts.set(handle, entry);
  }
  const authors = [...counts.entries()].sort((a, b) => b[1].n - a[1].n);

  const row = document.createElement("div");
  row.className = "chips";
  row.setAttribute("aria-label", "Filter by account");

  const makeChip = (label, active, onTap) => {
    const b = document.createElement("button");
    b.className = "chip" + (active ? " is-active" : "");
    b.textContent = label;
    b.setAttribute("aria-pressed", String(active));
    b.onclick = () => { onTap(); renderView(); };
    return b;
  };

  row.appendChild(makeChip("All", state.authorFilter.size === 0,
    () => state.authorFilter.clear()));

  for (const [handle, { name, n }] of authors) {
    // Beat writers are known by name, so the chip shows the name and keeps the handle as the
    // key — "Jonas Shaffer" is findable in a way "@jonas_shaffer" is not.
    row.appendChild(makeChip(`${shortName(name)} ${n}`, state.authorFilter.has(handle), () => {
      if (state.authorFilter.has(handle)) state.authorFilter.delete(handle);
      else state.authorFilter.add(handle);
    }));
  }
  return row;
}

// "Jeff Zrebiec (The Athletic)" -> "Jeff Zrebiec" — the outlet is noise on a chip.
function shortName(name) {
  return String(name || "").replace(/\s*\(.*$/, "").trim() || name;
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
