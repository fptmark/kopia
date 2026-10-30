import React, { useEffect, useState } from "react";
import Form from "react-bootstrap/Form";
import ProgressBar from "react-bootstrap/ProgressBar";
import Modal from "react-bootstrap/Modal";
import OverlayTrigger from "react-bootstrap/OverlayTrigger";
import Tooltip from "react-bootstrap/Tooltip";
import { FromLink } from "./FromLink";
import { formatLongDateTime, formatCount } from "../format";
import { useLoad } from "../hooks";
import { describeCovered, loadVerificationFailures } from "../verification";
import { CountText, DateTimeText, PathText, SizeText, StatusBadge } from "./Cells";
import { Loaded } from "./Feedback";
import { ConfirmDialog } from "./ConfirmDialog";

// the browser's own tooltip waits over a second; this one shows after half a second
export const TIP_DELAY = { show: 500, hide: 0 };

function VerifiedBadge({ v, onShowFailures, label, when }) {
  const at = when ? formatLongDateTime(when) + ". " : "";
  const tip = (text) => <Tooltip data-testid="verified-tooltip">{text}</Tooltip>;
  if (v.ok) {
    return (
      <OverlayTrigger
        placement="top"
        delay={TIP_DELAY}
        overlay={tip(`${at}Read back ${describeCovered(v)}; ${formatCount(v.files)} checked, no problems.`)}
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
        `${at}${formatCount(v.errorCount)} failed when reading back ${describeCovered(v)}. Click for the list.`,
      )}
    >
      <button
        type="button"
        className="btn btn-sm nx-icon-btn"
        onClick={() => onShowFailures(v)}
        data-testid="verify-failed"
      >
        <StatusBadge kind="error">{formatCount(v.errorCount)} failed</StatusBadge>
      </button>
    </OverlayTrigger>
  );
}

/** A slim bar at a known percent, or animated/striped while the total isn't known yet. The same bar everywhere
 * something is read back or checked: a running verify here, and a running task on the Tasks page. */
export function ProgressBit({ percent, ariaLabel }) {
  return (
    <ProgressBar
      now={percent ?? 100}
      animated={percent === null}
      striped={percent === null}
      style={{ height: "0.5rem", width: "6rem" }}
      aria-label={ariaLabel}
      {...(percent === null ? {} : { "aria-valuenow": percent })}
    />
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
export function VerifyProgress({ r }) {
  const n = (x) => formatCount(x);
  if (r.state === "queued") {
    return (
      <span className="nx-muted small" data-testid="verify-running">
        Queued ({whatIsRead(r)})
      </span>
    );
  }
  // the server fills in r.total (the snapshot's own file count) before it starts listing, well before it
  // knows how many of those files still need a read back, so a real percent only means something once listing
  // is done -- until then this stays indeterminate, same as a running task's bar with no counters yet.
  const known = r.total > 0 && r.phase !== "listing";
  const percent = known ? Math.min(100, Math.floor((r.files * 100) / r.total)) : null;
  return (
    <span className="nx-inline" data-testid="verify-running">
      <ProgressBit percent={percent} ariaLabel="Verification progress" />
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
    <span className="nx-inline" data-testid="verified-cell">
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

/**
 * The choice of what to read back: the data a snapshot added, or a percent of its files (100% is every file --
 * there's no separate "full" choice to pick between, since that's all the "full" mode ever meant). mode comes
 * out of onChange as "new", "sample" or "full" -- "full" exactly when the percent reaches 100 -- so callers
 * that already speak that three-way mode (the verify API, the per-snapshot-verify preference) don't change.
 */
export function VerifyModePicker({ mode, percent, onChange, name = "verify-mode" }) {
  const isNew = mode === "new";
  const shownPercent = mode === "full" ? 100 : percent;

  const setPercent = (p) => onChange(p >= 100 ? "full" : "sample", p);

  // its own buffer, not read straight from shownPercent: an unrelated re-render elsewhere in the app (the
  // health banner polls every few seconds) would otherwise snap a mid-edit, momentarily-empty box back to the
  // last committed number before the next keystroke could land.
  const [text, setText] = useState(String(shownPercent));
  useEffect(() => setText(String(shownPercent)), [shownPercent]);

  const typePercent = (raw) => {
    setText(raw);
    if (raw === "") {
      return;
    }
    const n = Number(raw);
    if (!Number.isNaN(n)) {
      setPercent(n);
    }
  };

  return (
    <>
      <div>
        <Form.Check
          type="radio"
          id={name + "-new"}
          name={name}
          label="Data added"
          checked={isNew}
          onChange={() => onChange("new", percent)}
        />
        <div className="nx-help">Quick.</div>
      </div>
      <div>
        <Form.Check
          type="radio"
          id={name + "-sample"}
          name={name}
          label="Verify files"
          checked={!isNew}
          onChange={() => setPercent(shownPercent || 10)}
        />
        {!isNew && (
          <div className="nx-row">
            <Form.Control
              size="sm"
              type="number"
              min={1}
              max={100}
              style={{ width: "6rem" }}
              aria-label="Percent of files"
              value={text}
              onChange={(e) => typePercent(e.target.value)}
            />
            <span>% of the files</span>
          </div>
        )}
      </div>
    </>
  );
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
          {formatCount(verification.errorCount)} {verification.errorCount === 1 ? "file" : "files"} failed to read back
        </Modal.Title>
      </Modal.Header>
      <Modal.Body data-testid="verify-failures">
        <p className="small">
          Read back {describeCovered(verification)} on <DateTimeText long value={verification.finishedAt} />;{" "}
          <CountText n={verification.files} /> checked, <SizeText bytes={verification.readBytes} /> read.
          {verification.taskId && (
            <>
              {" "}
              <FromLink to={"/tasks/" + verification.taskId} onClick={onClose}>
                Task log
              </FromLink>
            </>
          )}
        </p>
        <Loaded state={state}>
          {(d) => (
            <>
              <ul className="small">
                {d.failures.map((f) => (
                  <li key={f.path + f.error}>
                    <PathText>{f.path}</PathText>
                    <div className="nx-muted">{f.error}</div>
                  </li>
                ))}
              </ul>
              {d.failures.length < verification.errorCount && (
                <p className="nx-muted small">
                  Showing the first {formatCount(d.failures.length)} of {formatCount(verification.errorCount)}.
                </p>
              )}
            </>
          )}
        </Loaded>
      </Modal.Body>
    </Modal>
  );
}
