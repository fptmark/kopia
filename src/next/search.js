import { api } from "./api";

const DAY_MS = 24 * 3600 * 1000;
const DAY_PRESETS = [5, 30, 60, 90];

/** The time range of snapshots to search, from what the form says. */
export function searchRange(range, from, to, now = new Date()) {
  if (range === "all") {
    return {};
  }

  if (range === "thisYear") {
    return { from: new Date(now.getFullYear(), 0, 1).toISOString() };
  }

  if (range === "lastYear") {
    return {
      from: new Date(now.getFullYear() - 1, 0, 1).toISOString(),
      to: new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999).toISOString(),
    };
  }

  if (range === "custom") {
    const result = {};
    if (from) {
      result.from = new Date(from + "T00:00:00").toISOString();
    }
    if (to) {
      result.to = new Date(to + "T23:59:59.999").toISOString();
    }
    return result;
  }

  return { from: new Date(now.getTime() - Number(range) * DAY_MS).toISOString() };
}

/**
 * The ranges worth offering for the snapshots that exist: one is left out if no snapshot falls in it, or
 * (for "last N days") if it would add nothing over the shorter one before it.
 * avail is {count, first, last} or null.
 */
export function availableRanges(avail, now = new Date()) {
  const ranges = [];

  if (avail && avail.count > 0) {
    const first = new Date(avail.first).getTime();
    const last = new Date(avail.last).getTime();
    let previousStart = Infinity;

    for (const d of DAY_PRESETS) {
      const start = now.getTime() - d * DAY_MS;
      if (start <= last && (ranges.length === 0 || first < previousStart)) {
        ranges.push({ value: String(d), label: "Last " + d + " days" });
        previousStart = start;
      }
    }

    const overlaps = (r) =>
      (r.from ? new Date(r.from).getTime() : -Infinity) <= last &&
      (r.to ? new Date(r.to).getTime() : Infinity) >= first;

    if (overlaps(searchRange("thisYear", "", "", now))) {
      ranges.push({ value: "thisYear", label: "This year" });
    }
    if (overlaps(searchRange("lastYear", "", "", now))) {
      ranges.push({ value: "lastYear", label: "Last year" });
    }
  }

  ranges.push({ value: "all", label: "All snapshots" }, { value: "custom", label: "Custom range..." });

  return ranges;
}

/** When a version of a file was present: "4/3/2024 - 10/20/2026", or a single date. */
export function formatSeenRange(firstSeen, lastSeen) {
  const a = new Date(firstSeen).toLocaleDateString();
  const b = new Date(lastSeen).toLocaleDateString();
  return a === b ? a : a + " - " + b;
}

/** yyyy-mm-dd in local time, as date inputs want it. */
export function dateInputValue(iso) {
  const d = new Date(iso);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}

export const loadSearchRange = () => api.get("/api/v1/search-range").then((r) => r.data);
export const startSearch = (body) => api.post("/api/v1/search", body).then((r) => r.data);
export const loadSearch = (id) => api.get("/api/v1/search/" + id).then((r) => r.data);
export const cancelSearch = (id) => api.delete("/api/v1/search/" + id);

/** Where View/Browse and Restore go for a search result. */
export function resultLinks(r) {
  return {
    view: r.isDir
      ? "/snapshots/dir/" + r.objectId
      : "/api/v1/objects/" + r.objectId + "?fname=" + encodeURIComponent(r.name),
    viewIsPage: r.isDir,
    restore: "/snapshots/dir/" + r.objectId + "/restore",
  };
}
