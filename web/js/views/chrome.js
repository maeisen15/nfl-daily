/* Masthead, vertical switcher, scope tabs, bottom tab bar, theme. */

import { el, icon } from "../lib/dom.js";
import * as ICON from "../lib/icons.js";
import { store } from "../store.js";
import { state, verticals } from "../data.js";
import { tabFor } from "../router.js";

const THEMES = ["light", "dim", "dark"];
const THEME_ICON = { light: ICON.SUN, dim: ICON.DIM, dark: ICON.MOON };
const KEY = "nfl-daily.theme";

export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* storage disabled */ }
  const param = new URLSearchParams(location.search).get("theme");
  applyTheme(THEMES.includes(param) ? param : (THEMES.includes(saved) ? saved : "light"));

  document.getElementById("themeBtn").addEventListener("click", () => {
    const next = THEMES[(THEMES.indexOf(store.theme) + 1) % THEMES.length];
    try { localStorage.setItem(KEY, next); } catch { /* storage disabled */ }
    applyTheme(next);
  });
}

function applyTheme(theme) {
  store.theme = theme;
  document.documentElement.dataset.theme = theme;
  document.getElementById("themeIcon").setAttribute("d", THEME_ICON[theme]);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "light" ? "#FFFFFF" : theme === "dim" ? "#15202B" : "#000000";
}

/* ---------- vertical switcher ---------- */

/* The wordmark is the switcher: tapping it drops a short list of verticals. It lives there
 * rather than in a row of its own because the masthead and tab bar already spend a sixth of the
 * screen, and a second permanent row to hold two choices is not worth a sixth more. */
export function renderVerticals(onChange) {
  const btn = document.getElementById("verticalBtn");
  const menu = document.getElementById("verticalMenu");
  const list = verticals();
  const current = state.vertical?.code;

  // One vertical is not a choice. Leave the wordmark looking like a wordmark.
  const single = list.length < 2;
  btn.classList.toggle("is-static", single);
  btn.disabled = single;

  menu.replaceChildren(...list.map(v => el("button", {
    class: `vertical-item${v.code === current ? " is-active" : ""}`,
    onclick: () => { closeMenu(); onChange(v.code); },
  },
    el("span", { text: v.label }),
    v.code === current ? icon(ICON.CHECK, {}) : null,
  )));

  if (btn.dataset.wired) return;
  btn.dataset.wired = "1";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.hidden ? openMenu() : closeMenu();
  });
  // Anything else dismisses it — a tap on the feed behind it, or Escape from a keyboard.
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
}

function openMenu() {
  const btn = document.getElementById("verticalBtn");
  document.getElementById("verticalMenu").hidden = false;
  btn.setAttribute("aria-expanded", "true");
}

function closeMenu() {
  const menu = document.getElementById("verticalMenu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  document.getElementById("verticalBtn").setAttribute("aria-expanded", "false");
}

/* ---------- scopes and tabs ---------- */

export function renderScopes(onChange) {
  const nav = document.getElementById("scopes");
  const scopes = state.vertical?.scopes || [];
  // A row of tabs to choose between one thing is just a label taking up a row. Hide it, and
  // give the feed back the height — a vertical starts life with a single scope.
  nav.hidden = scopes.length < 2;
  nav.replaceChildren();
  if (!nav.hidden) {
    for (const scope of scopes) {
      nav.appendChild(el("button", {
        class: `scope${scope.code === store.scope ? " is-active" : ""}`,
        text: scope.short || scope.label,
        "aria-current": scope.code === store.scope ? "true" : null,
        onclick: () => onChange(scope.code),
      }));
    }
  }
  document.documentElement.dataset.scope = store.scope;
}

export function renderTabs(route) {
  const bar = document.getElementById("tabbar");
  const tabs = state.vertical?.tabs || [];
  // Rebuilt only when the set actually changes, so a route change inside one vertical doesn't
  // throw away the bar and re-create it under the thumb.
  const want = `${state.vertical?.code}:${tabs.join(",")}`;
  if (bar.dataset.built !== want) {
    bar.dataset.built = want;
    bar.replaceChildren(...tabs.map(name => el("a", {
      class: "tab",
      dataset: { tab: name },
      href: `#/${state.vertical.code}/${name}`,
    }, icon(ICON.TAB[name] || ""), el("span", { text: ICON.TAB_LABEL[name] || name }))));
  }

  const active = tabFor(route);
  for (const tab of bar.querySelectorAll(".tab")) {
    tab.classList.toggle("is-active", tab.dataset.tab === active);
  }
}

/* The masthead used to carry a "last updated" stamp. Every row now shows its own age and the
 * feed refreshes itself, so the only thing left worth saying is when it can't. */
export function renderStatus() {
  document.getElementById("status").textContent = store.offline ? "Offline" : "";
}

export function scopeCodes() {
  return (state.vertical?.scopes || []).map(s => s.code);
}
