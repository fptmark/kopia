import { api } from "./api";
import { DEFAULT_SUCCESS } from "../utils/rollup";

export { DEFAULT_SUCCESS };

export const DEFAULT_REPEAT_SECONDS = 12 * 3600;
export const MIN_REPEAT_SECONDS = 60;
export const MAX_REPEAT_SECONDS = 30 * 86400;

// the kinds of destination that can be added, and what a new one is called
export const TYPES = {
  mac: { name: "This Mac", menu: "This Mac", field: null },
  imessage: { name: "iPhone", menu: "iPhone", field: "phone number or Apple ID" },
  email: { name: "Email", menu: "Email", field: "name@example.com" },
};

// the failures a destination can choose to hear about; they are always sent as they happen
export const FAILURES = [
  { id: "health", name: "Backup problem found by the health check" },
  { id: "failed", name: "Snapshot failed" },
  { id: "skipped", name: "Snapshot finished with skipped files" },
  { id: "maint", name: "Maintenance or repository problem" },
];

export const SUCCESS = [
  { id: "off", name: "Off" },
  { id: "now", name: "Immediately, every snapshot" },
  { id: "daily", name: "Daily summary" },
  { id: "weekly", name: "Weekly summary" },
  { id: "monthly", name: "Monthly summary" },
];

export const EVENT_NAME = {
  health: "Backup problem",
  failed: "Snapshot failed",
  skipped: "Skipped files",
  maint: "Repository problem",
  watchdog: "Server stopped",
  done: "Snapshot completed",
  summary: "Summary",
  test: "Test message",
};

export function newDestination(type) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    type,
    name: TYPES[type].name,
    target: "",
    failures: ["health", "failed", "skipped", "maint", "watchdog"],
    success: { ...DEFAULT_SUCCESS },
  };
}

export function failuresLabel(d) {
  const n = FAILURES.filter((f) => d.failures?.includes(f.id)).length;
  if (n === 0) {
    return "None";
  }
  return n === FAILURES.length ? "All failures" : `${n} of ${FAILURES.length} failures`;
}

export const isScheduled = (d) => ["daily", "weekly", "monthly"].includes(d.success?.freq);

const URL = "/api/v1/notifications/destinations";

export const loadDestinations = () =>
  api.get(URL).then((r) => ({
    destinations: r.data?.destinations || [],
    repeatSeconds: r.data?.repeatSeconds || DEFAULT_REPEAT_SECONDS,
  }));
export const saveDestinations = (repeatSeconds, destinations) => api.put(URL, { repeatSeconds, destinations });
export const testDestination = (id) => api.post(`${URL}/${encodeURIComponent(id)}/test`, {});
export const loadNotificationLog = () =>
  api.get("/api/v1/notifications/log?limit=15").then((r) => (Array.isArray(r.data) ? r.data : []));
export const loadMailAccounts = () =>
  api.get("/api/v1/notifications/email-accounts").then((r) => r.data?.accounts || []);
