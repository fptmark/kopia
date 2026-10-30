import { api } from "./api";

export const loadHealth = () => api.get("/api/v1/verify/status").then((r) => r.data);
export const runHealthCheck = () => api.post("/api/v1/verify/run", {});

/** The failing checks of a health status, in the order the server lists them. */
export function failingChecks(status) {
  return (status?.checks || []).filter((c) => !c.ok);
}

// these two checks always point at one of status.failingSnapshots; once every one of those is cleared there,
// a failure under one of these names isn't shown again until a new one actually happens.
const SNAPSHOT_BACKED_CHECKS = new Set(["Data added by recent snapshots reads back", "Sample of stored data verifies"]);

/** Whether anything is failing that has no single snapshot to verify (staleness, skipped files, exclusion
 * drift, the restore spot check) -- the health banner falls back to its aggregate notice only for these. */
export function hasOtherFailingChecks(status) {
  return failingChecks(status).some((c) => !SNAPSHOT_BACKED_CHECKS.has(c.name));
}
