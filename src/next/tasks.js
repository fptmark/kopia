import { api } from "./api";
import { formatSpan } from "./format";

export { shortTaskError, taskDescription, taskErrorHint } from "../utils/taskutil";

export const TASK_PAGE_SIZE = 100;
export const TASK_STATUSES = ["Running", "Success", "Failed", "Canceled"];

/** Query parameters asking the server for the tasks that match the filters. */
export function taskQuery({ status, kind, search, from, to }) {
  const q = { limit: TASK_PAGE_SIZE };
  if (status && status !== "All") {
    q.status = status.toUpperCase();
  }
  if (kind && kind !== "All") {
    q.kind = kind;
  }
  if (search) {
    q.q = search;
  }
  if (from) {
    q.from = new Date(from + "T00:00:00").toISOString();
  }
  if (to) {
    q.to = new Date(to + "T23:59:59.999").toISOString();
  }
  return q;
}

export function loadTasks(filters, before) {
  const params = taskQuery(filters);
  if (before) {
    params.before = before;
  }
  return api.get("/api/v1/tasks", { params }).then((r) => r.data);
}

/** The next scheduled snapshots and verifies across every source, soonest first. */
export function loadUpcomingTasks(limit) {
  return api.get("/api/v1/tasks/upcoming", { params: { limit } }).then((r) => r.data);
}

export function loadTask(id) {
  return api.get("/api/v1/tasks/" + encodeURIComponent(id)).then((r) => r.data);
}

export function loadTaskErrors(id) {
  return api.get("/api/v1/tasks/" + encodeURIComponent(id) + "/errors").then((r) => r.data);
}

export function loadTaskLogs(id) {
  return api.get("/api/v1/tasks/" + encodeURIComponent(id) + "/logs").then((r) => r.data.logs || []);
}

export function cancelTask(id) {
  return api.post("/api/v1/tasks/" + encodeURIComponent(id) + "/cancel", {});
}

/** The states a task is in, as the server names them: the only place these words are written in the UI. */
export const TaskStatus = Object.freeze({
  RUNNING: "RUNNING",
  CANCELING: "CANCELING",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  CANCELED: "CANCELED",
});

export const isRunning = (t) => t.status === TaskStatus.RUNNING;
export const isSuccess = (t) => t.status === TaskStatus.SUCCESS;
/** A failed task that says why. */
export const failedWithMessage = (t) => t.status === TaskStatus.FAILED && !!t.errorMessage;

const SNAPSHOT_SOURCE_RE = /^([^@]*)@([^:]*):(.+) at \d{4}-\d{2}-\d{2}T\S+$/;
const VERIFY_SOURCE_RE = /^Verify snapshot of (.+) from \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(.+\)$/;

/**
 * The source a Snapshot or per-snapshot Verify task is tied to, parsed out of its description -- the
 * server doesn't carry it separately. null for a task that isn't about one source (Maintenance,
 * Repository, a repo-wide "Backup health check" Verify). A Verify's description only has the path, not
 * who it belongs to, so its source comes back with host and userName left out.
 */
export function taskSource(t) {
  const d = t.description || "";
  if (t.kind === "Snapshot") {
    const m = SNAPSHOT_SOURCE_RE.exec(d);
    return m ? { userName: m[1], host: m[2], path: m[3] } : null;
  }
  if (t.kind === "Verify") {
    const m = VERIFY_SOURCE_RE.exec(d);
    return m ? { path: m[1] } : null;
  }
  return null;
}

/**
 * "What" once Kind, Src and Started already say the rest: the verify mode, why an automatic verify ran, or
 * the maintenance/repository trigger -- empty when Kind alone says it all, e.g. a plain Snapshot.
 */
export function taskWhat(t) {
  const d = t.description || "";
  switch (t.kind) {
    case "Snapshot":
      return "";
    case "Verify": {
      const m = /^Verify snapshot of .+ from .+ \((.+)\)$/.exec(d);
      return m ? m[1] : d;
    }
    case "Maintenance":
      return d === "Periodic maintenance" ? "periodic" : d;
    case "Repository":
      return d === "Open" ? "server start" : d === "Connect" ? "connect" : d;
    default:
      return d;
  }
}

/** How long a task ran (or has been running), in words. */
export function taskDuration(t, now = Date.now()) {
  const end = t.endTime ? new Date(t.endTime).getTime() : now;
  return formatSpan(Math.max(0, end - new Date(t.startTime).getTime()));
}

/** How far a running Verify task has gotten, 0-100, or null while the total isn't known yet. */
export function verifyTaskPercent(t) {
  const files = t.counters?.["Files checked"]?.value ?? 0;
  const total = t.counters?.["Total files"]?.value;
  return total ? Math.min(100, Math.floor((files * 100) / total)) : null;
}

/** The kind of badge and the words for a task's status. */
export function taskStatus(t) {
  const d = taskDuration(t);
  switch (t.status) {
    case TaskStatus.RUNNING:
      return { kind: "running", text: "Running for " + d };
    case TaskStatus.CANCELING:
      return { kind: "warning", text: "Canceling" };
    case TaskStatus.SUCCESS:
      return t.failedFiles > 0
        ? { kind: "warning", text: "Finished in " + d }
        : { kind: "ok", text: "Finished in " + d };
    case TaskStatus.FAILED:
      return { kind: "error", text: "Failed after " + d };
    case TaskStatus.CANCELED:
      return t.cancelReason
        ? { kind: "warning", text: "Aborted — " + t.cancelReason }
        : { kind: "neutral", text: "Canceled after " + d };
    default:
      return { kind: "neutral", text: t.status };
  }
}
