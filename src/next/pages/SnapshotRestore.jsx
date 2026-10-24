import React, { useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { Link, useParams } from "react-router";
import { errorMessage } from "../api";
import { RESTORE_DEFAULTS, restoreRequest, startRestore } from "../browse";
import { Field, FormSection, Notice, Page, Panel, SwitchField } from "../ui";

const SWITCHES = [
  ["incremental", "Skip previously restored files and symlinks"],
  ["continueOnErrors", "Continue on errors", "When a restore error occurs, try to go on instead of stopping at once."],
  ["restoreOwnership", "Restore file ownership"],
  ["restorePermissions", "Restore file permissions"],
  ["restoreModTimes", "Restore file modification time"],
  ["overwriteFiles", "Overwrite files"],
  ["overwriteDirectories", "Overwrite folders"],
  ["overwriteSymlinks", "Overwrite symbolic links"],
  ["writeFilesAtomically", "Write files atomically"],
  ["writeSparseFiles", "Write sparse files"],
];

export function SnapshotRestore() {
  const { oid } = useParams();
  const [form, setForm] = useState(RESTORE_DEFAULTS);
  const [task, setTask] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = (e) => {
    e.preventDefault();
    if (!form.destination.trim()) {
      setError("Enter where to restore to.");
      return;
    }
    setBusy(true);
    setError("");
    startRestore(restoreRequest(oid, form))
      .then((r) => setTask(r.id))
      .catch((err) => setError("Not started: " + errorMessage(err)))
      .finally(() => setBusy(false));
  };

  if (task) {
    return (
      <Page title="Restore started" back>
        <Notice kind="success">
          The restore is running. <Link to={"/tasks/" + task}>Open the task</Link> to follow it.
        </Notice>
      </Page>
    );
  }

  const zip = form.destination.trim().endsWith(".zip");

  return (
    <Page title="Restore" back subtitle="Copy these files and folders out of the snapshot.">
      <Form onSubmit={submit}>
        <Panel title="Where to">
          <Field
            label="Destination"
            help="A folder to restore into. End the name with .zip or .tar to restore into one file."
            error={error}
          >
            {(id) => (
              <Form.Control
                id={id}
                autoFocus
                placeholder="enter destination path"
                value={form.destination}
                onChange={(e) => set("destination")(e.target.value)}
              />
            )}
          </Field>
        </Panel>
        <Panel title="Options">
          <div className="row">
            {SWITCHES.map(([k, label, help]) => (
              <div className="col-md-6" key={k}>
                <SwitchField label={label} help={help} checked={form[k]} onChange={set(k)} />
              </div>
            ))}
          </div>
          {zip && (
            <SwitchField
              label="Disable ZIP compression"
              help="Do not compress when restoring to a ZIP file (faster)."
              checked={form.uncompressedZip}
              onChange={set("uncompressedZip")}
            />
          )}
          <FormSection title="Shallow restore">
            <div className="row">
              <div className="col-md-6">
                <Field label="Shallow restore at depth">
                  {(id) => (
                    <Form.Control
                      id={id}
                      type="number"
                      min="0"
                      value={form.restoreDirEntryAtDepth}
                      onChange={(e) => set("restoreDirEntryAtDepth")(e.target.value)}
                    />
                  )}
                </Field>
              </div>
              <div className="col-md-6">
                <Field label="Minimal file size for shallow restore">
                  {(id) => (
                    <Form.Control
                      id={id}
                      type="number"
                      min="0"
                      value={form.minSizeForPlaceholder}
                      onChange={(e) => set("minSizeForPlaceholder")(e.target.value)}
                    />
                  )}
                </Field>
              </div>
            </div>
          </FormSection>
        </Panel>
        <Button variant="primary" type="submit" disabled={busy} data-testid="submit-button">
          Begin restore
        </Button>
      </Form>
    </Page>
  );
}
