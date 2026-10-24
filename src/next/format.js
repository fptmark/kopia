// One place for how the new UI shows sizes, counts, dates and durations.
import { compactCount, sizeDisplayName } from "../utils/formatutils";

export { compactCount, sizeDisplayName };

const dateTime = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const dateOnly = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" });

function toDate(v) {
  if (v === undefined || v === null || v === "") {
    return null;
  }
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Oct 23, 2026, 5:22 PM", or "" when there is no date. */
export function formatDateTime(v) {
  const d = toDate(v);
  return d ? dateTime.format(d) : "";
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
export function plural(n, word, pluralWord = word + "s") {
  return `${compactCount(n)} ${n === 1 ? word : pluralWord}`;
}

/** The last part of a path. */
export function baseName(path) {
  return String(path).replace(/\/+$/, "").split("/").pop();
}
