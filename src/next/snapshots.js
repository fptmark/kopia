import { api } from "./api";
import { sizeDisplayName } from "./format";
import { sourceQueryStringParams } from "../utils/policyutil";

export { sourceQueryStringParams };

/** "12 GB / 40 GB 30%" for a running upload; the total is only known when Kopia could estimate it. */
export function uploadProgress(u, base2) {
  if (!u) {
    return "";
  }
  const done = u.hashedBytes + u.cachedBytes;
  let text = sizeDisplayName(done, base2);
  if (u.estimatedBytes) {
    text += " / " + sizeDisplayName(u.estimatedBytes, base2);
    const percent = Math.round((done * 1000) / u.estimatedBytes) / 10;
    if (percent <= 100) {
      text += " " + percent + "%";
    }
  }
  return text;
}

export function loadSources() {
  return api.get("/api/v1/sources").then((r) => r.data);
}

export function startSnapshot(source) {
  return api.post("/api/v1/sources/upload?" + sourceQueryStringParams(source), {});
}

export function cancelSnapshot(source) {
  return api.post("/api/v1/sources/cancel?" + sourceQueryStringParams(source), {});
}

export function syncRepository() {
  return api.post("/api/v1/repo/sync", {});
}

/** Who a source belongs to: "user@host". */
export function ownerName(source) {
  return source.userName + "@" + source.host;
}

/** The failed-files summary of a source's newest snapshot, with what the dialog needs to act on it. */
export function failedSummary(row) {
  const summ = row.lastSnapshot?.rootEntry?.summ;
  if (!summ || !(summ.numFailed || summ.ignored)) {
    return null;
  }
  return { ...summ, source: row.source.path, userName: row.source.userName, host: row.source.host };
}

/** A source from the page's query string (host, userName, path). */
export function sourceFromSearch(search) {
  const q = new URLSearchParams(search);
  return { host: q.get("host") ?? "", userName: q.get("userName") ?? "", path: q.get("path") ?? "" };
}

export function loadHistory(source, all) {
  return api.get("/api/v1/snapshots?" + sourceQueryStringParams(source) + (all ? "&all=1" : "")).then((r) => r.data);
}

/** What each snapshot added to the repository: {snapshots: [{id, newBytes, newFiles, newDirs}]}. */
export function loadStorageStats(source) {
  return api.get("/api/v1/snapshots/storage-stats?" + sourceQueryStringParams(source)).then((r) => r.data);
}

export function deleteSnapshots(source, ids, deleteSourceAndPolicy = false) {
  return api.post("/api/v1/snapshots/delete", { source, snapshotManifestIds: ids, deleteSourceAndPolicy });
}

export function editSnapshots(req) {
  return api.post("/api/v1/snapshots/edit", req);
}

/**
 * How much a snapshot's logical size differs from the previous one, when that is worth a warning: more than
 * 25% and more than 100 MB. Returns the change in bytes, or null.
 */
export function sizeJump(size, previousSize) {
  if (size === undefined || previousSize === undefined || previousSize === 0) {
    return null;
  }
  const diff = size - previousSize;
  return Math.abs(diff) < 100e6 || Math.abs(diff) / previousSize < 0.25 ? null : diff;
}

/** Where the history of one source is shown. */
export const historyUrl = (source) => "/snapshots/single-source?" + sourceQueryStringParams(source);

export function loadDiff(from, to) {
  return api.get("/api/v1/snapshots/diff", { params: { from, to } }).then((r) => r.data);
}
