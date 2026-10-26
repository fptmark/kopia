import React, { useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { Link, useLocation, useParams } from "react-router";
import { errorMessage } from "../api";
import { plural } from "../format";
import { browseTrail, RESTORE_DEFAULTS, restoreRequest, startRestore } from "../browse";
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
  const location = useLocation();
  const items = location.state?.items ?? []; // the ticked entries; none means the whole folder
  const trail = browseTrail(location.state, oid);
  const [form, setForm] = useState(RESTORE_DEFAULTS);
  const [started, setStarted] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = (e) => {
    e.preventDefault();
    if (!form.destination.trim()) {
      setError("Enter where to restore to.");
      return;
    }
    const dst = form.destination.trim();
    if (items.length && /\.(zip|tar)$/.test(dst)) {
      setError("Zip and tar hold the whole folder. Untick the entries, or restore into a folder.");
      return;
    }
    setBusy(true);
    setError("");
    const requests = items.length
      ? items.map((it) => restoreRequest(it.obj, { ...form, destination: dst.replace(/\/+$/, "") + "/" + it.name }))
      : [restoreRequest(oid, form)];
    Promise.all(requests.map(startRestore))
      .then((rs) => setStarted(rs.map((x) => x.id)))
      .catch((err) => setError("Not started: " + errorMessage(err)))
      .finally(() => setBusy(false));
  };

  if (started.length) {
    return (
      <Page title="Restore started" trail={trail}>
        <Notice kind="success">
          {started.length === 1 ? (
            <Link to={"/tasks/" + started[0]}>Open the task</Link>
          ) : (
            <>
              {started.length} restores are running. <Link to="/tasks">Open Tasks</Link>
            </>
          )}
        </Notice>
      </Page>
    );
  }

  const zip = form.destination.trim().endsWith(".zip");

  return (
    <Page
      title="Restore"
      trail={trail}
      subtitle={items.length ? plural(items.length, "item") + " selected" : undefined}
    >
      <Form onSubmit={submit}>
        <Panel>
          <Field
            label={items.length ? "Destination folder" : "Destination"}
            help={items.length ? undefined : "A folder. End with .zip or .tar for one file."}
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
