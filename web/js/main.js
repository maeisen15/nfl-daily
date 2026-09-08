/* Wiring: boot, routing, scroll restoration, and the three ways the feed refreshes. */

import { el, icon } from "./lib/dom.js";
import * as ICON from "./lib/icons.js";
import { store, set, mergeTweets, pendingForScope } from "./store.js";
import { parse, go, onRoute, key as routeKey } from "./router.js";
import * as data from "./data.js";
import { initTheme, renderScopes, renderTabs, renderStatus, scopeCodes } from "./views/chrome.js";
import { renderFeed, watchSentinel, hydrateFeed } from "./views/feed.js";
import { renderDetail, hydrateDetail } from "./views/detail.js";
import { renderArticles } from "./views/articles.js";
import { renderHome } from "./views/home.js";
import { renderLiked, hydrateLiked } from "./views/liked.js";
import { fetchTweets } from "./data.js";

const main = document.getElementById("main");
const SCOPE_KEY = "nfl-daily.scope";
const POLL_MS = 60_000;

let currentKey = null;

boot();

async function boot() {
  initTheme();

  try {
    await data.loadStatic();
  } catch {
    main.replaceChildren(el("div", { class: "empty",
      text: "Couldn't load. Check your connection and pull down to retry." }));
    return;
  }

  const params = new URLSearchParams(location.search);
  let saved = null;
  try { saved = localStorage.getItem(SCOPE_KEY); } catch { /* storage disabled */ }
  const wanted = params.get("scope") || saved;
  store.scope = scopeCodes().includes(wanted) ? wanted : data.state.config.default_scope;

  renderScopes(changeScope);
  onRoute(render);
  render(parse());

  // Tweets are fetched after the first paint so the shell and the articles tab are usable
  // immediately, rather than everything waiting on the Worker.
  const page = await data.loadFirstTweets();
  set({
    tweets: mergeTweets([], page.items),
    cursor: page.cursor,
    exhausted: !page.cursor,
    newestSeen: page.newest,
    offline: data.state.offline,
  });
  renderStatus();
  if (parse().name === "tweets") render(parse());

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poll();
  });
  initPullToRefresh();
  initSwipe();
}

/* ---------- routing ---------- */

function render(route = parse()) {
  const nextKey = routeKey(route);
  // A re-render in place — more tweets paged in, a pill emptied — must not move the page.
  // Only an actual navigation banks the old position and restores the new one.
  const sameRoute = currentKey === nextKey;
  const heldScroll = window.scrollY;
  if (currentKey && !sameRoute) store.scrollPositions[currentKey] = heldScroll;
  currentKey = nextKey;

  renderTabs(route);
  renderStatus();

  let view;
  switch (route.name) {
    case "tweet":    view = renderDetail(route.id, back); break;
    case "articles": view = renderArticles(store.scope); break;
    case "home":     view = renderHome(store.scope); break;
    case "liked":    view = renderLiked(); break;
    default:         view = renderFeed(store.scope); break;
  }

  main.replaceChildren(view);
  renderPill();

  if (route.name === "tweets") { hydrateFeed(main); watchSentinel(main, () => render(parse())); }
  if (route.name === "tweet") hydrateDetail(main);
  if (route.name === "liked") hydrateLiked(main);

  if (sameRoute) {
    window.scrollTo(0, heldScroll);
  } else {
    // A detail view opens at the top; a list returns to where it was left.
    window.scrollTo(0, route.name === "tweet" ? 0 : (store.scrollPositions[currentKey] || 0));
  }
}

function back() {
  // Back through history keeps the feed's scroll restoration working; the fallback is for a
  // detail view opened directly from a shared or reloaded URL.
  if (history.length > 1) history.back();
  else go("/tweets");
}

function changeScope(code) {
  if (code === store.scope) return;
  store.scope = code;
  try { localStorage.setItem(SCOPE_KEY, code); } catch { /* storage disabled */ }
  // Scroll positions are per scope as much as per route; keeping them would drop you into the
  // middle of a feed you haven't seen.
  store.scrollPositions = {};
  renderScopes(changeScope);
  const route = parse();
  if (route.name === "tweet") go("/tweets");
  else render(route);
}

/* ---------- refresh ---------- */

/* New tweets are fetched but held out of the feed. Inserting them live would move the list
 * under a thumb mid-read, so they wait behind a pill — which is what Twitter does. */
async function poll() {
  if (document.visibilityState !== "visible") return;
  try {
    const page = await fetchTweets({ limit: 60, since: true });
    const known = new Set(store.tweets.map(t => t.id));
    const pendingIds = new Set(store.pending.map(t => t.id));
    const fresh = page.items.filter(t => !known.has(t.id) && !pendingIds.has(t.id));
    const wasOffline = store.offline;
    store.offline = false;
    data.state.offline = false;
    if (fresh.length) {
      set({ pending: mergeTweets(store.pending, fresh) });
      renderPill();
    }
    if (wasOffline) renderStatus();
  } catch {
    store.offline = true;
    data.state.offline = true;
    renderStatus();
  }
}

function renderPill() {
  document.querySelector(".new-pill")?.remove();
  if (parse().name !== "tweets") return;
  const n = pendingForScope(store.scope).length;
  if (!n) return;
  document.body.appendChild(el("button", {
    class: "new-pill",
    text: `${n} new post${n === 1 ? "" : "s"}`,
    onclick: showPending,
  }));
}

function showPending() {
  set({ tweets: mergeTweets(store.tweets, store.pending), pending: [] });
  render(parse());
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function refreshNow() {
  try {
    const page = await fetchTweets({ limit: 200, since: true });
    store.offline = false;
    data.state.offline = false;
    set({ tweets: mergeTweets(store.tweets, [...store.pending, ...page.items]), pending: [] });
    render(parse());
  } catch {
    store.offline = true;
    data.state.offline = true;
    renderStatus();
  }
}

/* ---------- pull to refresh ---------- */

function initPullToRefresh() {
  const indicator = el("div", { class: "ptr" }, icon(ICON.REFRESH, {}));
  main.before(indicator);

  let startY = null, pulling = false;
  const THRESHOLD = 70;

  main.addEventListener("touchstart", (e) => {
    if (window.scrollY > 0 || e.touches.length !== 1) { startY = null; return; }
    startY = e.touches[0].clientY;
    pulling = false;
  }, { passive: true });

  main.addEventListener("touchmove", (e) => {
    if (startY === null || window.scrollY > 0) return;
    const delta = e.touches[0].clientY - startY;
    if (delta > 12) {
      pulling = true;
      indicator.classList.toggle("armed", delta > THRESHOLD);
    }
  }, { passive: true });

  main.addEventListener("touchend", async () => {
    if (!pulling) { startY = null; return; }
    const armed = indicator.classList.contains("armed");
    startY = null; pulling = false;
    if (!armed) { indicator.classList.remove("armed"); return; }
    indicator.classList.add("spinning");
    await refreshNow();
    indicator.classList.remove("armed", "spinning");
  }, { passive: true });
}

/* ---------- swipe between scopes ---------- */

function initSwipe() {
  let x0 = null, y0 = null;
  main.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) { x0 = null; return; }
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });

  main.addEventListener("touchend", (e) => {
    if (x0 === null || parse().name === "tweet") return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    x0 = null;
    // Horizontal, decisive, and clearly not a scroll.
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
    const codes = scopeCodes();
    const i = codes.indexOf(store.scope);
    const next = codes[i + (dx < 0 ? 1 : -1)];
    if (next) changeScope(next);
  }, { passive: true });
}
