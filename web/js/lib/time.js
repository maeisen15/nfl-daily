/* Twitter's compact clock: minutes, then hours, then a date. No "ago" — the column is narrow
 * and the unit carries the meaning. */

export function shortTime(iso) {
  const dt = new Date(iso);
  if (isNaN(dt)) return "";
  const secs = Math.max(0, (Date.now() - dt.getTime()) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s`;
  const mins = secs / 60;
  if (mins < 60) return `${Math.floor(mins)}m`;
  const hrs = mins / 60;
  if (hrs < 24) return `${Math.floor(hrs)}h`;
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return dt.toLocaleDateString(undefined,
    sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/* The detail view shows the real time, the way Twitter's permalink does. */
export function fullTime(iso) {
  const dt = new Date(iso);
  if (isNaN(dt)) return "";
  const time = dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const date = dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${time} · ${date}`;
}

export function dayLabel(iso) {
  const dt = new Date(iso);
  if (isNaN(dt)) return "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(dt); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return dt.toLocaleDateString(undefined, { weekday: "long" });
  return dt.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/* 1_234 -> "1.2K". Twitter drops the decimal past ten thousand. */
export function compactCount(n) {
  if (n === null || n === undefined) return "";
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "";
  if (v < 1000) return String(v);
  if (v < 10000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  if (v < 1000000) return `${Math.round(v / 1000)}K`;
  return `${(v / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
}
