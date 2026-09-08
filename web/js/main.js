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
import { renderBrief } from "./views/brief.js";
import { renderLiked, hydrateLiked } from "./views/liked.js";
import { renderSettings } from "./views/settings.js";
import { renderSchedule } from "./views/schedule.js";
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
  // Every view is re-rendered, not just the feed: the app reopens on whatever URL it was left
  // on, and a detail view drawn before the tweets arrived would otherwise stay empty forever.
  render(parse());

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
    case "schedule": view = renderSchedule(route.params); break;
    case "brief":    view = renderBrief(store.scope); break;
    case "liked":    view = renderLiked(); break;
    case "settings": view = renderSettings(); break;
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
  // A team's season belongs to the team, not the scope you were in when you opened it, so
  // changing scope leaves it rather than showing the Ravens under a Rivals heading.
  else if (route.name === "schedule" && route.params.get("team")) go("/schedule");
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

/* The feed follows the thumb and snaps on release. Measuring the gesture only after the finger
 * lifts is what made this feel late: nothing moved during the drag, and anything short of a
 * decisive flick was thrown away. */
function initSwipe() {
  const SNAP = "swipe-snap";
  let x0 = null, y0 = null, dx = 0, axis = null, width = 0;

  const clear = () => {
    x0 = null; axis = null; dx = 0;
    main.style.transform = "";
  };

  main.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || parse().name === "tweet") { x0 = null; return; }
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    dx = 0; axis = null;
    width = main.clientWidth || window.innerWidth;
    main.classList.remove(SNAP);
  }, { passive: true });

  main.addEventListener("touchmove", (e) => {
    if (x0 === null) return;
    const mx = e.touches[0].clientX - x0;
    const my = e.touches[0].clientY - y0;
    // Decide once which way this gesture is going, and stay out of the way if it's a scroll.
    if (!axis) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      axis = Math.abs(mx) > Math.abs(my) * 1.2 ? "x" : "y";
      if (axis === "y") { x0 = null; return; }
    }
    const codes = scopeCodes();
    const i = codes.indexOf(store.scope);
    // The first and last scope resist rather than slide, so an edge reads as an edge and not
    // as a swipe that failed.
    const atEdge = (mx > 0 && i <= 0) || (mx < 0 && i >= codes.length - 1);
    dx = atEdge ? mx * 0.25 : mx;
    main.style.transform = `translateX(${dx}px)`;
  }, { passive: true });

  const settle = () => {
    if (x0 === null || axis !== "x") { clear(); return; }
    const codes = scopeCodes();
    const next = codes[codes.indexOf(store.scope) + (dx < 0 ? 1 : -1)];
    const far = Math.abs(dx) > Math.min(64, width * 0.22);
    const dir = dx < 0 ? -1 : 1;
    x0 = null; axis = null;

    main.classList.add(SNAP);
    if (!next || !far) {
      main.style.transform = "";
      return;
    }
    // Out under the thumb, swap the scope while off-screen, then in from the other side.
    main.style.transform = `translateX(${dir * width}px)`;
    once(main, () => {
      main.classList.remove(SNAP);
      main.style.transform = `translateX(${-dir * width}px)`;
      changeScope(next);
      requestAnimationFrame(() => {
        main.classList.add(SNAP);
        main.style.transform = "";
      });
    });
  };

  main.addEventListener("touchend", settle, { passive: true });
  main.addEventListener("touchcancel", () => {
    main.classList.add(SNAP);
    clear();
  }, { passive: true });
}

/* transitionend can simply not arrive — an interrupted or zero-length transition never fires
 * it — and a swipe that never completes would leave the feed stranded off-screen. */
function once(el, fn) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    el.removeEventListener("transitionend", run);
    clearTimeout(timer);
    fn();
  };
  const timer = setTimeout(run, 320);
  el.addEventListener("transitionend", run);
}
