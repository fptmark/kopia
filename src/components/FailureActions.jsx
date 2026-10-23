import { useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import Modal from "react-bootstrap/Modal";
import {
  addIgnoredError,
  EXPIRY_CHOICES,
  excludeFromBackup,
  excludePattern,
  KIND_LABELS,
} from "../utils/ignoredErrors";

const errorText = (e) => e?.response?.data?.message || e?.message || "unknown error";

/**
 * The choices for ignoring errors at a place: target is {path, kind, file}. A file offers itself first;
 * a folder offers the kind of error it has, then every error under it.
 */
export function ignoreChoices(target) {
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

/** Asks how widely to ignore an error, and saves the rule. source is the source folder. */
export function IgnoreDialog({ source, target, onClose, onDone }) {
  const choices = ignoreChoices(target);
  const [choice, setChoice] = useState(choices[0].id);
  const [days, setDays] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = () => {
    setBusy(true);
    addIgnoredError({ ...choices.find((c) => c.id === choice).rule, source, expiresDays: days })
      .then(() => onDone())
      .catch((e) => {
        setBusy(false);
        setError("Not saved: " + errorText(e));
      });
  };

  return (
    <Modal show onHide={onClose} data-testid="ignore-dialog">
      <Modal.Header closeButton>
        <Modal.Title>Ignore this error</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="mb-2">
          <code style={{ wordBreak: "break-all" }}>{target.path || source}</code>
        </div>
        <Form.Group className="mb-3">
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
        <Form.Group className="d-flex align-items-center gap-2 mb-3">
          <Form.Label className="mb-0">Ignore for</Form.Label>
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
        <div className="text-muted small">
          Ignored errors stay in the snapshot record, but no longer count as failures or cause alerts. Manage them under
          Preferences → Ignored errors.
        </div>
        {error && (
          <div className="text-danger mt-2" role="alert">
            {error}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save} disabled={busy} data-testid="ignore-confirm">
          Ignore
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/** Confirms excluding a path from future backups, by adding it to the source's policy. */
export function ExcludeDialog({ source, userName, host, target, onClose, onDone }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = () => {
    setBusy(true);
    excludeFromBackup({ userName, host, path: source }, target.path)
      .then((pattern) => onDone(pattern))
      .catch((e) => {
        setBusy(false);
        setError("Not changed: " + errorText(e));
      });
  };

  return (
    <Modal show onHide={onClose} data-testid="exclude-dialog">
      <Modal.Header closeButton>
        <Modal.Title>Exclude from backup</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <div className="mb-2">
          Stop backing up <code style={{ wordBreak: "break-all" }}>{target.path}</code>?
        </div>
        <div className="small mb-2">
          This adds <code>{excludePattern(target.path)}</code> to the ignore rules of the policy for{" "}
          <code>{source}</code>. The next snapshot skips it. Copies already in earlier snapshots stay until those
          snapshots are removed by retention.
        </div>
        {error && (
          <div className="text-danger mt-2" role="alert">
            {error}
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" onClick={save} disabled={busy} data-testid="exclude-confirm">
          Exclude
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
