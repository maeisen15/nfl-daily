/* Masthead, scope tabs, bottom tab bar, theme. */

import { el } from "../lib/dom.js";
import * as ICON from "../lib/icons.js";
import { store, set } from "../store.js";
import { state } from "../data.js";
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

export function renderScopes(onChange) {
  const nav = document.getElementById("scopes");
  nav.replaceChildren();
  for (const scope of state.config.scopes) {
    nav.appendChild(el("button", {
      class: `scope${scope.code === store.scope ? " is-active" : ""}`,
      text: scope.short || scope.label,
      "aria-current": scope.code === store.scope ? "true" : null,
      onclick: () => onChange(scope.code),
    }));
  }
  document.documentElement.dataset.scope = store.scope;
}

export function renderTabs(route) {
  const active = tabFor(route);
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("is-active", tab.dataset.tab === active);
  }
}

/* The masthead used to carry a "last updated" stamp. Every row now shows its own age and the
 * feed refreshes itself, so the only thing left worth saying is when it can't. */
export function renderStatus() {
  document.getElementById("status").textContent = store.offline ? "Offline" : "";
}

export function scopeCodes() {
  return (state.config?.scopes || []).map(s => s.code);
}
