import { faBan, faCheck, faExclamationCircle, faXmark } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import axios from "axios";
import React from "react";
import Spinner from "react-bootstrap/Spinner";
import { formatDuration } from "./formatutils";

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

export function taskStatusSymbol(task) {
  const st = task.status;
  const dur = formatDuration(task.startTime, task.endTime, true);

  switch (st) {
    case "RUNNING":
      return (
        <>
          <Spinner animation="border" variant="primary" size="sm" /> Running for {dur}
          <button className="btn btn-sm btn-link" type="button" onClick={() => cancelTask(task.id)}>
            <FontAwesomeIcon color="red" size="lg" title="Cancel task" icon={faXmark} />
          </button>
        </>
      );
    case "SUCCESS":
      return (
        <p title={dur}>
          <FontAwesomeIcon icon={faCheck} color="green" /> Finished in {dur}
        </p>
      );

    case "FAILED":
      return (
        <p title={dur}>
          <FontAwesomeIcon icon={faExclamationCircle} color="red" /> Failed after {dur}
        </p>
      );

    case "CANCELED":
      return (
        <p title={dur}>
          <FontAwesomeIcon icon={faBan} /> Canceled after {dur}
        </p>
      );

    default:
      return st;
  }
}
