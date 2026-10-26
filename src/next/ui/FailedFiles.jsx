import React, { useEffect, useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import Modal from "react-bootstrap/Modal";
import { Link } from "react-router";
import { api, errorMessage } from "../api";
import { addExclusions, coveredPaths } from "../exclusions";
import { addIgnoredError, EXPIRY_CHOICES, KIND_LABELS } from "../../utils/ignoredErrors";
import { groupFailures } from "../../utils/uiutil";
import { shortTaskError, taskErrorHint } from "../../utils/taskutil";
import { PathText, StatusBadge } from "./Cells";
import { ConfirmDialog } from "./ConfirmDialog";
import { Notice } from "./Feedback";

/**
 * The choices for ignoring an error at a place: target is {path, kind, file}. A file offers itself first;
 * a folder offers the kind of error it has, then every error under it.
 */
function ignoreChoices(target) {
  const where = target.path ? "this folder" : "this source";
  if (target.file) {
    return [
      { id: "file", label: "Only this file", rule: { path: target.path, scope: "file" } },
      { id: "any", label: "Any error on it", rule: { path: target.path, scope: "folder" } },
    ];
  }

  const choices = [];
  if (target.kind) {
    choices.push({
      id: "kind",
      label: `${KIND_LABELS[target.kind] || target.kind} in ${where}`,
      rule: { path: target.path, scope: "folder", kind: target.kind },
    });
  }
  choices.push({ id: "any", label: `Any error in ${where}`, rule: { path: target.path, scope: "folder" } });
  return choices;
}

function IgnoreDialog({ source, target, onClose, onDone }) {
  const choices = ignoreChoices(target);
  const [choice, setChoice] = useState(choices[0].id);
  const [days, setDays] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = () => {
    setBusy(true);
    addIgnoredError({ ...choices.find((c) => c.id === choice).rule, source, expiresDays: days })
      .then(onDone)
      .catch((e) => {
        setBusy(false);
        setError("Not saved: " + errorMessage(e));
      });
  };

  return (
    <ConfirmDialog
      show
      title="Ignore this error"
      confirmLabel="Ignore"
      busy={busy}
      onCancel={onClose}
      onConfirm={save}
      data-testid="ignore-dialog"
    >
      <div>
        <PathText>{target.path || source}</PathText>
      </div>
      <Form.Group >
        {choices.map((c) => (
          <Form.Check
            key={c.id}
            type="radio"
            name="ignore-scope"
            id={"ignore-" + c.id}
            label={c.label}
            checked={choice === c.id}
            onChange={() => setChoice(c.id)}
          />
        ))}
      </Form.Group>
      <Form.Group className="nx-row">
        <Form.Label >Ignore for</Form.Label>
        <Form.Select
          size="sm"
          style={{ width: "auto" }}
          aria-label="Ignore for"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {EXPIRY_CHOICES.map((c) => (
            <option key={c.days} value={c.days}>
              {c.label}
            </option>
          ))}
        </Form.Select>
      </Form.Group>
      <div className="nx-help">
        Ignored errors stay in the snapshot record, but no longer count as failures or cause alerts. Manage them under
        Preferences, Ignored errors.
      </div>
      {error && <Notice kind="error">{error}</Notice>}
    </ConfirmDialog>
  );
}

function ExcludeDialog({ source, target, onClose, onDone }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pattern = "/" + target.path.replace(/^\/+/, "");

  const save = () => {
    setBusy(true);
    addExclusions([{ source, pattern }], "failed")
      .then((r) => onDone(pattern, r))
      .catch((e) => {
        setBusy(false);
        setError("Not changed: " + errorMessage(e));
      });
  };

  return (
    <ConfirmDialog
      show
      title="Exclude from backup"
      confirmLabel="Exclude"
      danger
      busy={busy}
      onCancel={onClose}
      onConfirm={save}
      data-testid="exclude-dialog"
    >
      <p>
        Stop backing up <PathText>{target.path}</PathText>?
      </p>
      <p className="small">
        This adds <PathText>{pattern}</PathText> as a rule for <PathText>{source}</PathText>. The next snapshot skips
        it. Copies already in earlier snapshots stay until retention removes them.
      </p>
      {error && <Notice kind="error">{error}</Notice>}
    </ConfirmDialog>
  );
}

function Group({ group, onIgnore, onExclude, covered }) {
  const [open, setOpen] = useState(false);
  const allCovered = group.items.length > 0 && group.items.every((i) => covered[i.path]);
  const patterns = [...new Set(group.items.map((i) => covered[i.path]).filter(Boolean))];

  return (
    <div data-testid="failure-group">
      <div className="nx-row">
        <span className="text-danger">{group.reason}</span>
        <button
          type="button"
          className="btn btn-sm nx-icon-btn text-start"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "▾" : "▸"} <PathText>{group.label}</PathText> <span className="nx-muted">({group.count})</span>
        </button>
        {onIgnore && (
          <span className="nx-row nx-end">
            {allCovered && (
              <span className="nx-muted align-self-center" data-testid="group-excluded">
                Excluded{patterns.length === 1 ? " by " + patterns[0] : ""}
              </span>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={allCovered}
              onClick={() => onIgnore({ path: group.place, kind: group.kind, file: group.count === 1 })}
            >
              Ignore
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={allCovered}
              onClick={() => onExclude({ path: group.place })}
            >
              Exclude
            </Button>
          </span>
        )}
      </div>
      {open && (
        <ul className="small">
          {group.items.map((i) => (
            <li key={i.path} >
              <div className="nx-row">
                <PathText>{i.path}</PathText>
                {onIgnore && (
                  <span className="nx-row nx-end">
                    {covered[i.path] && (
                      <span className="nx-muted align-self-center" data-testid="file-excluded">
                        Excluded by {covered[i.path]}
                      </span>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!!covered[i.path]}
                      onClick={() => onIgnore({ path: i.path, kind: i.kind, file: true })}
                    >
                      Ignore
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!!covered[i.path]}
                      onClick={() => onExclude({ path: i.path })}
                    >
                      Exclude
                    </Button>
                  </span>
                )}
              </div>
              <div className="nx-muted">{i.error}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The files a snapshot could not read, grouped by cause and place. With a source each error can be ignored
 * (stops counting as a failure) or excluded from the backup (adds a rule). summ is
 * {numFailed, errors: [{path, error, kind?, ignored?}], source?, taskId?, ignored?}.
 */
export function FailedFilesDialog({ summ, onClose }) {
  const [errors, setErrors] = useState(summ.errors || []);
  const [dialog, setDialog] = useState(null);
  const [covered, setCovered] = useState({});
  const [note, setNote] = useState("");

  const canAct = !!summ.source;
  const shown = errors.filter((e) => !e.ignored);

  // which failed paths the rules already leave out; a failed lookup just leaves the buttons active
  const [recheck, setRecheck] = useState(0);
  useEffect(() => {
    const paths = errors.filter((e) => !e.ignored).map((e) => e.path);
    if (!canAct || !paths.length) {
      return;
    }
    try {
      coveredPaths(summ.source, paths)
        .then(setCovered)
        .catch(() => {});
    } catch {
      // nothing to show
    }
  }, [canAct, summ.source, errors, recheck]);
  const nowIgnored = errors.filter((e) => e.ignored).length - (summ.ignored || 0);
  const numFailed = Math.max(0, summ.numFailed - Math.max(0, nowIgnored));

  const reload = () =>
    summ.taskId
      ? api
          .get("/api/v1/tasks/" + summ.taskId + "/errors")
          .then((r) => setErrors(r.data.errors || []))
          .catch(() => {})
      : Promise.resolve();

  return (
    <Modal show onHide={onClose} size="lg" scrollable>
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="fs-5">
          {numFailed === 1 ? "1 file" : numFailed + " files"} could not be backed up
        </Modal.Title>
      </Modal.Header>
      <Modal.Body data-testid="snapshot-errors">
        {note && <Notice kind="success">{note}</Notice>}
        {groupFailures(shown).map((g) => (
          <Group
            key={g.reason + g.label}
            group={g}
            covered={covered}
            onIgnore={canAct ? (t) => setDialog({ type: "ignore", target: t }) : null}
            onExclude={canAct ? (t) => setDialog({ type: "exclude", target: t }) : null}
          />
        ))}
        {errors.length - shown.length > 0 && (
          <div className="nx-muted small" data-testid="ignored-count">
            {errors.length - shown.length} more {errors.length - shown.length === 1 ? "error is" : "errors are"}{" "}
            ignored. Manage them under{" "}
            <Link to="/preferences" onClick={onClose}>
              Preferences
            </Link>
            , Ignored errors.
          </div>
        )}
        {errors.length < summ.numFailed + (summ.ignored || 0) && (
          <div className="nx-muted small">
            Showing the first {errors.length} of {summ.numFailed + (summ.ignored || 0)} errors. Kopia only records a
            limited number per snapshot.
          </div>
        )}
      </Modal.Body>
      {dialog?.type === "ignore" && (
        <IgnoreDialog
          source={summ.source}
          target={dialog.target}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setNote("Ignored. These errors no longer count as failures or cause alerts.");
            reload();
          }}
        />
      )}
      {dialog?.type === "exclude" && (
        <ExcludeDialog
          source={summ.source}
          target={dialog.target}
          onClose={() => setDialog(null)}
          onDone={(pattern, r) => {
            setDialog(null);
            setRecheck((n) => n + 1);
            setNote(
              r.applyError
                ? `Rule ${pattern} added, but Kopia's policy was not updated: ${r.applyError}`
                : `Excluded ${pattern}. The next snapshot skips it.`,
            );
          }}
        />
      )}
    </Modal>
  );
}

/** A badge with the number of failed files that opens the list. summ as for FailedFilesDialog. */
export function FailedBadge({ summ, onOpen }) {
  if (!summ || !summ.numFailed) {
    return null;
  }
  const lines = (summ.errors || []).slice(0, 5).map((e) => e.path + ": " + e.error);
  return (
    <button
      type="button"
      className="btn btn-sm nx-icon-btn"
      title={lines.join("\n")}
      data-testid="show-snapshot-errors"
      onClick={() => onOpen(summ)}
    >
      <StatusBadge kind="warning">{summ.numFailed} failed</StatusBadge>
    </button>
  );
}

/** The error of a failed task: the short cause, a hint for known macOS permission errors, the full message. */
export function TaskErrorDialog({ info, onClose }) {
  const hint = taskErrorHint(info.message);
  return (
    <Modal show onHide={onClose} size="lg" scrollable>
      <Modal.Header closeButton>
        <Modal.Title as="h2" className="fs-5">
          {info.title}
        </Modal.Title>
      </Modal.Header>
      <Modal.Body data-testid="task-error-dialog">
        <Notice kind="error" title="Failed:">
          {shortTaskError(info.message)}
          {hint && <div>{hint}</div>}
        </Notice>
        <div className="nx-muted small">Full message</div>
        <pre className="text-break" style={{ whiteSpace: "pre-wrap" }}>
          {info.message}
        </pre>
        {info.taskId && (
          <Link to={"/tasks/" + info.taskId} onClick={onClose}>
            Open the task and its log
          </Link>
        )}
      </Modal.Body>
    </Modal>
  );
}
