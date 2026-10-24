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

const isNewData = (mode) => mode === "new";

/**
 * Groups the answer by snapshot: {[snapshotId]: {read, added, running}} where read is the latest full or sample
 * verification, added the latest one of the data the snapshot added, and running what is queued or reading now.
 */
export function groupVerifications(data) {
  const out = {};
  const of = (id) => (out[id] ||= { read: null, added: null, running: [] });
  for (const v of data?.verifications || []) {
    of(v.snapshotId)[isNewData(v.mode) ? "added" : "read"] = v;
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
