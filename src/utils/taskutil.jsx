import axios from "axios";

export function cancelTask(tid) {
  axios
    .post("/api/v1/tasks/" + tid + "/cancel", {})
    .then((_result) => {})
    .catch((_error) => {});
}

/**
 * The end of a long error chain, which is the actual cause: "...: dial tcp 10.0.0.2:22: connect: no route to host"
 * becomes "connect: no route to host". The full message stays available on the task page.
 */
export function shortTaskError(message) {
  if (!message) {
    return "";
  }
  const parts = message.split(": ");
  const tail = parts.slice(-2).join(": ").trim();
  return tail.length > 140 ? "…" + tail.slice(-140) : tail;
}

/** A hint for errors that have a well-known fix, or an empty string. */
export function taskErrorHint(message) {
  if (/no route to host|network is unreachable/i.test(message || "")) {
    return "The Mac could not reach the host. If it is on the local network, check that this app has the Local Network permission (System Settings > Privacy & Security > Local Network).";
  }
  if (/operation not permitted/i.test(message || "")) {
    return "macOS blocked access. Give this app Full Disk Access (System Settings > Privacy & Security > Full Disk Access).";
  }
  return "";
}

/**
 * What a task did, in words. The server describes some tasks only by a mode ("Open"), a snapshot by its source and
 * start time (the start time has its own column).
 */
export function taskDescription(task) {
  const d = task.description || "";

  switch (task.kind) {
    case "Repository":
      if (d === "Open") {
        return "Open the repository (server start)";
      }
      if (d === "Connect") {
        return "Connect to the repository";
      }
      return d;
    case "Snapshot": {
      const m = /^[^:]+:(.+) at \d{4}-\d{2}-\d{2}T\S+$/.exec(d);
      return m ? "Snapshot of " + m[1] : d;
    }
    case "Maintenance":
      return d === "Periodic maintenance" ? "Repository maintenance (periodic)" : d;
    case "Verify":
      return d.replace(/^Backup health check \((.+)\)$/, "Backup health check ($1)");
    default:
      return d;
  }
}
