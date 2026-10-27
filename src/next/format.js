// One place for how the new UI shows sizes, counts, dates and durations.
import { compactCount, sizeDisplayName } from "../utils/formatutils";

export { compactCount, sizeDisplayName };

export const DATE_FORMATS = [
  {
    id: "medium",
    label: "Oct 26, 2026, 7:00 AM",
    options: { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  },
  {
    id: "numeric",
    label: "10/26/2026, 7:00 AM",
    options: { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" },
  },
  { id: "iso", label: "2026-10-26 07:00", iso: true },
];

const formatters = Object.fromEntries(
  DATE_FORMATS.filter((f) => !f.iso).map((f) => [f.id, new Intl.DateTimeFormat("en-US", f.options)]),
);
const longDateTime = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});
const dateOnly = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" });

// the format summary pages (tables, lists, banners) use; the Preferences provider sets it
let summaryFormat = "medium";

export function setSummaryDateFormat(id) {
  summaryFormat = DATE_FORMATS.some((f) => f.id === id) ? id : "medium";
}

const pad = (n) => String(n).padStart(2, "0");

function toDate(v) {
  if (v === undefined || v === null || v === "") {
    return null;
  }
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A date and time in the format chosen in Preferences ("Oct 23, 2026, 5:22 PM" by default), "" when there is no date. */
export function formatDateTime(v) {
  const d = toDate(v);
  if (!d) {
    return "";
  }
  if (summaryFormat === "iso") {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return formatters[summaryFormat].format(d);
}

/** "Monday, October 26, 2026 at 7:00:00 AM": what a page about one thing (a snapshot, a task) shows. */
export function formatLongDateTime(v) {
  const d = toDate(v);
  return d ? longDateTime.format(d).replace(/(\d{4}),/, "$1 at") : "";
}

/** "Oct 23, 2026". */
export function formatDate(v) {
  const d = toDate(v);
  return d ? dateOnly.format(d) : "";
}

/** "5 min ago", "3 h ago", "2 d ago"; older than 30 days is the date. */
export function formatAgo(v, now = Date.now()) {
  const d = toDate(v);
  if (!d) {
    return "";
  }
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 0) {
    return formatDateTime(d);
  }
  if (s < 45) {
    return "just now";
  }
  if (s < 3600) {
    return Math.round(s / 60) + " min ago";
  }
  if (s < 86400) {
    return Math.round(s / 3600) + " h ago";
  }
  if (s < 30 * 86400) {
    return Math.round(s / 86400) + " d ago";
  }
  return formatDate(d);
}

/** "1 h 5 min", "42 s", "850 ms" from milliseconds. */
export function formatSpan(ms) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) {
    return "";
  }
  if (ms < 1000) {
    return Math.round(ms) + " ms";
  }
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return s + " s";
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return m + " min" + (s % 60 ? " " + (s % 60) + " s" : "");
  }
  const h = Math.floor(m / 60);
  return h + " h" + (m % 60 ? " " + (m % 60) + " min" : "");
}

/** "+1.1 TB" / "-300 MB" for a change in bytes. */
export function formatSizeChange(n, base2 = false) {
  return (n < 0 ? "-" : "+") + sizeDisplayName(Math.abs(n), base2);
}

/** Plural by count: plural(1, "file") is "1 file", plural(3, "file") is "3 files". */
/** Whether the text contains the search words typed in a filter box (ignoring case and surrounding spaces). */
export function includesText(text, query) {
  const needle = (query ?? "").trim().toLowerCase();
  return !needle || String(text).toLowerCase().includes(needle);
}

/** Copies text to the clipboard; a browser that refuses is not an error worth showing. */
export function copyText(text) {
  return navigator.clipboard?.writeText(text).catch(() => {});
}

/** A whole count with thousands separators, the same everywhere. */
export function formatCount(n) {
  return Number(n).toLocaleString("en-US");
}

export function plural(n, word, pluralWord = word + "s") {
  return `${compactCount(n)} ${n === 1 ? word : pluralWord}`;
}

/** The last part of a path. */
export function baseName(path) {
  return String(path).replace(/\/+$/, "").split("/").pop();
}
