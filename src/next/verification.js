import { api } from "./api";

/** Queues a read-back of each snapshot. mode: "new" (the data each added), "sample" (percent of the files) or "full". */
export function verifySnapshots(snapshotIds, mode, percent) {
  return api.post("/api/v1/snapshots/verify", { snapshotIds, mode, percent }).then((r) => r.data);
}

/** What is known about the health of these snapshots: {verifications: [...], running: [...]}. */
export function loadVerifications(snapshotIds) {
  return api.post("/api/v1/snapshots/verifications", { snapshotIds }).then((r) => r.data);
}

/** One verification and the files that failed in it. */
export function loadVerificationFailures(id, limit = 2000) {
  return api
    .get("/api/v1/snapshots/verifications/" + encodeURIComponent(id) + "/failures", { params: { limit } })
    .then((r) => r.data);
}

/** Hides these failing verifications from the health banner until a newer one of the same source and mode
 * replaces them; it does not change the stored result itself (the History page still shows it). */
export function dismissVerifications(ids) {
  return api.post("/api/v1/verify/failing/dismiss", { ids }).then((r) => r.data);
}

/**
 * Groups the answer by snapshot: {[snapshotId]: {latest, running}} where latest is the most recent finished
 * verification, whether the daily check, a snapshot's own check or a manual Verify made it, and running is what
 * is queued or reading now.
 */
export function groupVerifications(data) {
  const out = {};
  const of = (id) => (out[id] ||= { latest: null, running: [] });
  for (const v of data?.verifications || []) {
    const o = of(v.snapshotId);
    if (!o.latest || v.id > o.latest.id) {
      o.latest = v;
    }
  }
  for (const r of data?.running || []) {
    of(r.snapshotId).running.push(r);
  }
  return out;
}

/** What a finished verification covered, in words. */
export function describeCovered(v) {
  if (v.mode === "new") {
    return "the data this snapshot added";
  }
  if (v.mode === "sample") {
    return v.percent + "% of the files";
  }
  return "every file";
}
