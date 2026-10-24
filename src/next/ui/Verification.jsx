import React, { useState } from "react";
import Form from "react-bootstrap/Form";
import Modal from "react-bootstrap/Modal";
import { Link } from "react-router";
import { useLoad } from "../hooks";
import { describeCovered, loadVerificationFailures } from "../verification";
import { CountText, DateTimeText, PathText, SizeText, StatusBadge } from "./Cells";
import { Loaded } from "./Feedback";
import { ConfirmDialog } from "./ConfirmDialog";

function VerifiedBadge({ v, onShowFailures, label }) {
  if (v.ok) {
    return (
      <span title={`Read back ${describeCovered(v)}; ${v.files.toLocaleString("en-US")} checked, no problems.`}>
        <StatusBadge kind="ok">{label}</StatusBadge>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="btn btn-sm p-0 border-0"
      title={`${v.errorCount.toLocaleString("en-US")} failed when reading back ${describeCovered(v)}. Click for the list.`}
      onClick={() => onShowFailures(v)}
      data-testid="verify-failed"
    >
      <StatusBadge kind="error">{v.errorCount.toLocaleString("en-US")} failed</StatusBadge>
    </button>
  );
}

/**
 * What is known about one snapshot's health: a badge for the latest full or sample read-back, one for the
 * data it added, and progress while one is queued or running. info is {read, added, running} from groupVerifications.
 */
export function VerifiedCell({ info, onShowFailures }) {
  if (!info || (!info.read && !info.added && !info.running.length)) {
    return <span className="nx-muted">{"—"}</span>;
  }
  return (
    <span className="d-inline-flex flex-wrap gap-1 align-items-center" data-testid="verified-cell">
      {info.running.map((r) => (
        <span key={r.mode} className="nx-muted small" data-testid="verify-running">
          {r.state === "queued" ? "Queued" : "Verifying"} (
          {r.mode === "new" ? "added data" : r.mode === "sample" ? r.percent + "%" : "all"}
          {r.state === "running" && r.files ? ", " + r.files.toLocaleString("en-US") + " checked" : ""})
        </span>
      ))}
      {info.read && (
        <VerifiedBadge
          v={info.read}
          onShowFailures={onShowFailures}
          label={info.read.mode === "full" ? "Verified" : info.read.percent + "% verified"}
        />
      )}
      {info.added && <VerifiedBadge v={info.added} onShowFailures={onShowFailures} label="Added data ok" />}
    </span>
  );
}

const MODES = [
  {
    id: "new",
    label: "Data this snapshot added",
    help: "Reads back everything the snapshot wrote to the repository. Usually quick, and exactly what a bad write would damage.",
  },
  {
    id: "sample",
    label: "A sample of the files",
    help: "Reads back a share of the files, chosen at random. Quick to run, but can miss a few damaged files.",
  },
  {
    id: "full",
    label: "Every file",
    help: "Reads back the whole snapshot from the NAS. Thorough but slow: the home folder is hundreds of GB.",
  },
];

/** Asks what to read back for the selected snapshots. onStart gets (mode, percent). */
export function VerifyDialog({ count, busy, onStart, onCancel }) {
  const [mode, setMode] = useState("new");
  const [percent, setPercent] = useState(10);
  const bad = mode === "sample" && !(percent > 0 && percent < 100);
  return (
    <ConfirmDialog
      show
      title={count === 1 ? "Verify snapshot" : `Verify ${count} snapshots`}
      confirmLabel="Start"
      busy={busy}
      disabled={bad}
      onCancel={onCancel}
      onConfirm={() => onStart(mode, mode === "sample" ? Number(percent) : 100)}
      data-testid="verify-dialog"
    >
      {MODES.map((m) => (
        <div key={m.id} className="mb-2">
          <Form.Check
            type="radio"
            id={"verify-" + m.id}
            name="verify-mode"
            label={m.label}
            checked={mode === m.id}
            onChange={() => setMode(m.id)}
          />
          <div className="nx-help ms-4">{m.help}</div>
          {m.id === "sample" && mode === "sample" && (
            <div className="ms-4 mt-1 d-flex align-items-center gap-2">
              <Form.Control
                size="sm"
                type="number"
                min={1}
                max={99}
                style={{ width: "6rem" }}
                aria-label="Percent of files"
                value={percent}
                onChange={(e) => setPercent(e.target.value)}
              />
              <span>% of the files</span>
            </div>
          )}
        </div>
      ))}
      <p className="nx-muted small mb-0">
        Each snapshot runs as a Verify task, one at a time, so they do not compete for the NAS. The result stays on the
        snapshot; failed files are listed by name.
      </p>
    </ConfirmDialog>
  );
}

/** The files that failed to read back in one verification. verification is the summary row that was clicked. */
export function VerifyFailuresDialog({ verification, onClose }) {
  const state = useLoad(() => loadVerificationFailures(verification.id), [verification.id]);
  return (
    <Modal show onHide={onClose} size="lg" scrollable>
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="fs-5">
          {verification.errorCount.toLocaleString("en-US")} {verification.errorCount === 1 ? "file" : "files"} failed to
          read back
        </Modal.Title>
      </Modal.Header>
      <Modal.Body data-testid="verify-failures">
        <p className="small">
          Read back {describeCovered(verification)} on <DateTimeText value={verification.finishedAt} />;{" "}
          <CountText n={verification.files} /> checked, <SizeText bytes={verification.readBytes} /> read.
          {verification.taskSeq > 0 && (
            <>
              {" "}
              <Link to={"/tasks/" + verification.taskSeq.toString(16)} onClick={onClose}>
                Task log
              </Link>
            </>
          )}
        </p>
        <Loaded state={state}>
          {(d) => (
            <>
              <ul className="small mb-0">
                {d.failures.map((f) => (
                  <li key={f.path + f.error} className="mb-1">
                    <PathText>{f.path}</PathText>
                    <div className="nx-muted">{f.error}</div>
                  </li>
                ))}
              </ul>
              {d.failures.length < verification.errorCount && (
                <p className="nx-muted small mt-2">
                  Showing the first {d.failures.length.toLocaleString("en-US")} of{" "}
                  {verification.errorCount.toLocaleString("en-US")}.
                </p>
              )}
            </>
          )}
        </Loaded>
      </Modal.Body>
    </Modal>
  );
}
