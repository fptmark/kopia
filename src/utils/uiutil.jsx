import { faExclamationTriangle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import React, { useState, useSyncExternalStore } from "react";
import Alert from "react-bootstrap/Alert";
import Modal from "react-bootstrap/Modal";
import { Link } from "react-router";
import { sizeDisplayName } from "./formatutils.js";
import { shortTaskError, taskErrorHint } from "./taskutil.jsx";

// The failures dialog lives outside the snapshot tables: they refresh periodically and rebuild their
// cells, which would reset any state held by a component rendered inside a cell.
let openFailures = null;
const failuresListeners = new Set();

function setOpenFailures(summ) {
  openFailures = summ;
  failuresListeners.forEach((l) => l());
}

/**
 * Opens the dialog listing failed files, grouped by cause and place.
 * @param {{numFailed: number, errors: {path: string, error: string}[]}} summ
 */
export function showFailures(summ) {
  setOpenTaskError(null);
  setOpenFailures(summ);
}

let openTaskError = null;
const taskErrorListeners = new Set();

function setOpenTaskError(info) {
  openTaskError = info;
  taskErrorListeners.forEach((l) => l());
}

/**
 * Opens the dialog with the error of a failed task.
 * @param {{taskId?: string, title: string, message: string}} info
 */
export function showTaskError(info) {
  setOpenFailures(null);
  setOpenTaskError(info);
}

function subscribeTaskError(listener) {
  taskErrorListeners.add(listener);
  return () => taskErrorListeners.delete(listener);
}

function subscribeFailures(listener) {
  failuresListeners.add(listener);
  return () => failuresListeners.delete(listener);
}

/**
 * Returns the most specific cause of an error. Kopia wraps errors into a chain like
 * "cannot create iterator: unable to read directory: open /a/b/c: permission denied".
 * The segments that contain a path are dropped (they would make every error unique) and the
 * innermost remaining one is kept ("permission denied"). If only generic wrappers remain,
 * the innermost wrapper is used ("unable to read directory").
 */
// A segment contains a path if some word in it starts with "/" ("open /a/b"). A slash inside a word,
// as in "input/output error", is part of a normal error reason.
function looksLikePath(segment) {
  return /(^|\s)\//.test(segment);
}

export function errorReason(message) {
  const segments = (message || "")
    .split(": ")
    .map((x) => x.trim())
    .filter((x) => x && !looksLikePath(x));

  return segments.length > 0 ? segments[segments.length - 1] : message || "unknown error";
}

function commonPrefix(lists) {
  let prefix = lists[0];
  for (const l of lists.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < l.length && prefix[i] === l[i]) {
      i++;
    }
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/**
 * Groups failures that have the same cause and live in the same part of the tree
 * (same first `depth` directories), e.g. "operation not permitted on Library/Accounts (12)".
 * Larger groups come first.
 */
export function groupFailures(errors, depth = 3) {
  const buckets = new Map();

  for (const e of errors) {
    const dirs = e.path.split("/").filter(Boolean).slice(0, -1);
    const reason = errorReason(e.error);
    const key = reason + "\u0000" + dirs.slice(0, depth).join("/");
    if (!buckets.has(key)) {
      buckets.set(key, { reason, items: [] });
    }
    buckets.get(key).items.push({ ...e, dirs });
  }

  const groups = [...buckets.values()].map(({ reason, items }) => {
    const dir = commonPrefix(items.map((i) => i.dirs)).join("/");
    return {
      reason,
      count: items.length,
      label: items.length === 1 ? items[0].path : dir || "(top level)",
      items: items.map(({ path, error }) => ({ path, error })).sort((a, b) => a.path.localeCompare(b.path)),
    };
  });

  return groups.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function FailureGroup({ group }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-2" data-testid="failure-group">
      <span className="text-danger">{group.reason}</span>
      <span className="text-body">: </span>
      <button
        type="button"
        className="btn btn-link p-0 align-baseline text-start"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "▾" : "▸"} <code style={{ wordBreak: "break-all" }}>{group.label}</code>
      </button>
      <span className="text-body"> ({group.count})</span>
      {open && (
        <ul className="small mt-1 mb-0">
          {group.items.map((i) => (
            <li key={i.path} style={{ wordBreak: "break-all" }}>
              <code>{i.path}</code>
              <div className="text-muted">{i.error}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskErrorModal({ info }) {
  const hint = taskErrorHint(info.message);
  return (
    <Modal show onHide={() => setOpenTaskError(null)} size="lg" scrollable>
      <Modal.Header closeButton>
        <Modal.Title>{info.title}</Modal.Title>
      </Modal.Header>
      <Modal.Body data-testid="task-error-dialog">
        <Alert variant="danger" className="mb-3">
          <b>Failed:</b> {shortTaskError(info.message)}
          {hint && <div className="mt-1">{hint}</div>}
        </Alert>
        <div className="text-muted small mb-1">Full message</div>
        <pre className="mb-3 text-break" style={{ whiteSpace: "pre-wrap" }}>
          {info.message}
        </pre>
        {info.taskId && (
          <Link to={"/tasks/" + info.taskId} onClick={() => setOpenTaskError(null)}>
            Open the task and its log
          </Link>
        )}
      </Modal.Body>
    </Modal>
  );
}

export function FailuresModalHost() {
  const summ = useSyncExternalStore(subscribeFailures, () => openFailures);
  const taskError = useSyncExternalStore(subscribeTaskError, () => openTaskError);

  if (taskError) {
    return <TaskErrorModal info={taskError} />;
  }

  if (!summ) {
    return null;
  }

  return (
    <Modal show onHide={() => setOpenFailures(null)} size="lg" scrollable>
      <Modal.Header closeButton>
        <Modal.Title>{summ.numFailed === 1 ? "1 error" : summ.numFailed + " errors"} while snapshotting</Modal.Title>
      </Modal.Header>
      <Modal.Body data-testid="snapshot-errors">
        {groupFailures(summ.errors).map((g) => (
          <FailureGroup key={g.reason + g.label} group={g} />
        ))}
        {summ.errors.length < summ.numFailed && (
          <div className="text-muted small">
            Showing the first {summ.errors.length} of {summ.numFailed} errors. Kopia only records a limited number per
            snapshot.
          </div>
        )}
      </Modal.Body>
    </Modal>
  );
}

export function sizeWithFailures(size, summ, bytesStringBase2) {
  if (size === undefined) {
    return "";
  }

  if (!summ || !summ.errors || !summ.numFailed) {
    return <span>{sizeDisplayName(size, bytesStringBase2)}</span>;
  }

  let caption = "Encountered " + summ.numFailed + " errors:\n\n";
  let prefix = "- ";
  if (summ.numFailed === 1) {
    caption = "Error: ";
    prefix = "";
  }

  caption += summ.errors.map((x) => prefix + x.path + ": " + x.error).join("\n");

  return (
    <span>
      {sizeDisplayName(size, bytesStringBase2)}&nbsp;
      <FontAwesomeIcon
        color="red"
        icon={faExclamationTriangle}
        title={caption}
        role="button"
        data-testid="show-snapshot-errors"
        style={{ cursor: "pointer" }}
        onClick={() => setOpenFailures(summ)}
      />
    </span>
  );
}

/**
 * In case of an error, redirect to the repository selection
 * @param {error} The error that was returned
 */
export function redirect(e) {
  if (e && e.response && e.response.data && e.response.data.code === "NOT_CONNECTED") {
    window.location.replace("/repo");
  }
}

export function errorAlert(err, prefix) {
  if (!prefix) {
    prefix = "Error";
  }

  prefix += ": ";

  if (err.response && err.response.data && err.response.data.error) {
    alert(prefix + err.response.data.error);
  } else if (err instanceof Error) {
    alert(err);
  } else {
    alert(prefix + JSON.stringify(err));
  }
}

export function toAlgorithmOption(x, defaultID) {
  let text = x.id;

  if (x.id === defaultID) {
    text = x.id + " (RECOMMENDED)";
  }

  if (x.deprecated) {
    text = x.id + " (NOT RECOMMENDED)";
  }

  return (
    <option key={x.id} value={x.id}>
      {text}
    </option>
  );
}
