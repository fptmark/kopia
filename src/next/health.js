import { api } from "./api";

export const loadHealth = () => api.get("/api/v1/verify/status").then((r) => r.data);
export const runHealthCheck = () => api.post("/api/v1/verify/run", {});

/** The failing checks of a health status, in the order the server lists them. */
export function failingChecks(status) {
  return (status?.checks || []).filter((c) => !c.ok);
}
