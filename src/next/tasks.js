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

/** How long a task ran (or has been running), in words. */
export function taskDuration(t, now = Date.now()) {
  const end = t.endTime ? new Date(t.endTime).getTime() : now;
  return formatSpan(Math.max(0, end - new Date(t.startTime).getTime()));
}

/** The kind of badge and the words for a task's status. */
export function taskStatus(t) {
  const d = taskDuration(t);
  switch (t.status) {
    case "RUNNING":
      return { kind: "running", text: "Running for " + d };
    case "CANCELING":
      return { kind: "warning", text: "Canceling" };
    case "SUCCESS":
      return t.failedFiles > 0
        ? { kind: "warning", text: "Finished in " + d }
        : { kind: "ok", text: "Finished in " + d };
    case "FAILED":
      return { kind: "error", text: "Failed after " + d };
    case "CANCELED":
      return { kind: "neutral", text: "Canceled after " + d };
    default:
      return { kind: "neutral", text: t.status };
  }
}
