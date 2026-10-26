import React, { useState } from "react";
import Form from "react-bootstrap/Form";
import ProgressBar from "react-bootstrap/ProgressBar";
import Modal from "react-bootstrap/Modal";
import OverlayTrigger from "react-bootstrap/OverlayTrigger";
import Tooltip from "react-bootstrap/Tooltip";
import { Link } from "react-router";
import { formatLongDateTime } from "../format";
import { useLoad } from "../hooks";
import { describeCovered, loadVerificationFailures } from "../verification";
import { CountText, DateTimeText, PathText, SizeText, StatusBadge } from "./Cells";
import { Loaded } from "./Feedback";
import { ConfirmDialog } from "./ConfirmDialog";

// the browser's own tooltip waits over a second; this one shows after half a second
const TIP_DELAY = { show: 500, hide: 0 };

function VerifiedBadge({ v, onShowFailures, label, when }) {
  const at = when ? formatLongDateTime(when) + ". " : "";
  const tip = (text) => <Tooltip data-testid="verified-tooltip">{text}</Tooltip>;
  if (v.ok) {
    return (
      <OverlayTrigger
        placement="top"
        delay={TIP_DELAY}
        overlay={tip(`${at}Read back ${describeCovered(v)}; ${v.files.toLocaleString("en-US")} checked, no problems.`)}
      >
        <span>
          <StatusBadge kind="ok">{label}</StatusBadge>
        </span>
      </OverlayTrigger>
    );
  }
  return (
    <OverlayTrigger
      placement="top"
      delay={TIP_DELAY}
      overlay={tip(
        `${at}${v.errorCount.toLocaleString("en-US")} failed when reading back ${describeCovered(v)}. Click for the list.`,
      )}
    >
      <button
        type="button"
        className="btn btn-sm p-0 border-0"
        onClick={() => onShowFailures(v)}
        data-testid="verify-failed"
      >
        <StatusBadge kind="error">{v.errorCount.toLocaleString("en-US")} failed</StatusBadge>
      </button>
    </OverlayTrigger>
  );
}

const whatIsRead = (r) =>
  r.mode === "new" ? "added data" : r.mode === "sample" ? r.percent + "% sample" : "every file";

const idleSeconds = (r) => (r.progressAt ? Math.floor((Date.now() - new Date(r.progressAt).getTime()) / 1000) : 0);
const idleMinutes = (r) => (idleSeconds(r) >= 60 ? Math.floor(idleSeconds(r) / 60) || 1 : 0);
const elapsedText = (r) => {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(r.progressAt).getTime()) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
};
const idleText = (r) => idleMinutes(r) + " min";

/** A verification that is queued or running: a bar of files checked out of the files to check, and what it is doing. */
function VerifyProgress({ r }) {
  const n = (x) => x.toLocaleString("en-US");
  if (r.state === "queued") {
    return (
      <span className="nx-muted small" data-testid="verify-running">
        Queued ({whatIsRead(r)})
      </span>
    );
  }
  const known = r.total > 0;
  const percent = known ? Math.min(100, Math.floor((r.files * 100) / r.total)) : null;
  return (
    <span className="d-inline-flex align-items-center gap-2" data-testid="verify-running">
      <ProgressBar
        now={percent ?? 100}
        animated={percent === null}
        striped={percent === null}
        style={{ height: "0.5rem", width: "6rem" }}
        aria-label="Verification progress"
        {...(percent === null ? {} : { "aria-valuenow": percent })}
      />
      <span className="nx-muted small">
        {r.phase === "listing"
          ? "Listing stored data · " + elapsedText(r)
          : "Verifying" + (r.mode === "sample" ? " " + r.percent + "%" : r.mode === "new" ? " added data" : "")}
        {idleMinutes(r) >= (r.phase === "listing" ? 5 : 1) && (
          <span className="text-warning-emphasis">
            {" "}
            {"·"} no progress for {idleText(r)}, waiting on the NAS
          </span>
        )}
        {r.errors > 0 && (
          <span className="text-danger">
            {" "}
            {"·"} {n(r.errors)} failed
          </span>
        )}
      </span>
    </span>
  );
}

const badgeLabel = (v) =>
  v.mode === "new" ? "Added data ok" : v.mode === "sample" ? v.percent + "% verified" : "Verified";

/**
 * What is known about one snapshot's health: a badge for its latest verification (automatic or manual) with when
 * it finished, and progress while one is queued or running. info is {latest, running} from groupVerifications.
 */
export function VerifiedCell({ info, onShowFailures }) {
  if (!info || (!info.latest && !info.running.length)) {
    return <span className="nx-muted">{"—"}</span>;
  }
  return (
    <span className="d-inline-flex gap-2 align-items-center" data-testid="verified-cell">
      {info.running.map((r) => (
        <VerifyProgress key={r.mode} r={r} />
      ))}
      {info.latest && (
        <VerifiedBadge
          v={info.latest}
          onShowFailures={onShowFailures}
          label={badgeLabel(info.latest)}
          when={info.latest.finishedAt}
        />
      )}
    </span>
  );
}

const MODES = [
  {
    id: "new",
    label: "Data this snapshot added",
    help: "Quick.",
  },
  {
    id: "sample",
    label: "A sample of the files",
    help: "A random share of the files.",
  },
  {
    id: "full",
    label: "Every file",
    help: "Thorough but slow.",
  },
];

/** The choice of what to read back: the data a snapshot added, a sample, or every file. */
export function VerifyModePicker({ mode, percent, onChange, name = "verify-mode" }) {
  return MODES.map((m) => (
    <div key={m.id} className="mb-2">
      <Form.Check
        type="radio"
        id={name + "-" + m.id}
        name={name}
        label={m.label}
        checked={mode === m.id}
        onChange={() => onChange(m.id, percent)}
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
            onChange={(e) => onChange(mode, e.target.value)}
          />
          <span>% of the files</span>
        </div>
      )}
    </div>
  ));
}

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
      <VerifyModePicker
        mode={mode}
        percent={percent}
        onChange={(m, p) => {
          setMode(m);
          setPercent(p);
        }}
      />
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
          Read back {describeCovered(verification)} on <DateTimeText long value={verification.finishedAt} />;{" "}
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
