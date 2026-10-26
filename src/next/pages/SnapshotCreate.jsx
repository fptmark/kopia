import React, { useEffect, useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import InputGroup from "react-bootstrap/InputGroup";
import Spinner from "react-bootstrap/Spinner";
import { useNavigate } from "react-router";
import { api, errorMessage } from "../api";
import { useDebounced } from "../hooks";
import { PolicyFields } from "../policy/PolicyFields";
import { usePolicy } from "../policy/usePolicy";
import { cancelTask, loadTask } from "../tasks";
import { CliCommand, Field, Notice, Page, Panel, SizeText, Stat, Stats } from "../ui";

/** The result of an estimate: what a snapshot of the folder would hold, with the counts of what is left out. */
function Estimate({ taskId }) {
  const [task, setTask] = useState(null);

  useEffect(() => {
    let live = true;
    const tick = () =>
      loadTask(taskId).then((t) => {
        if (live) {
          setTask(t);
        }
        return t;
      });
    const timer = window.setInterval(
      () =>
        tick()
          .then((t) => t.endTime && window.clearInterval(timer))
          .catch(() => {}),
      500,
    );
    tick().catch(() => {});
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [taskId]);

  if (!task?.counters) {
    return <Spinner animation="border" size="sm" />;
  }
  const c = (k) => task.counters[k]?.value ?? 0;
  const running = task.status === "RUNNING";

  return (
    <Panel
      title={running ? "Estimating" : "Estimate"}
      data-testid="estimate-result"
      actions={
        running && (
          <Button size="sm" variant="secondary" onClick={() => cancelTask(task.id)}>
            Cancel
          </Button>
        )
      }
    >
      <Stats>
        <Stat
          label="Size"
          value={<SizeText bytes={c("Bytes")} />}
          note={
            <>
              <SizeText bytes={c("Excluded Bytes")} /> excluded
            </>
          }
        />
        <Stat
          label="Files"
          value={c("Files").toLocaleString("en-US")}
          note={`${c("Excluded Files").toLocaleString("en-US")} excluded`}
        />
        <Stat
          label="Folders"
          value={c("Directories").toLocaleString("en-US")}
          note={`${c("Excluded Directories").toLocaleString("en-US")} excluded`}
        />
        <Stat
          label="Errors"
          value={c("Errors").toLocaleString("en-US")}
          note={`${c("Ignored Errors").toLocaleString("en-US")} ignored`}
        />
      </Stats>
    </Panel>
  );
}

export function SnapshotCreate() {
  const navigate = useNavigate();
  const [path, setPath] = useState("");
  const typed = useDebounced(path, 300);
  const [source, setSource] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);

  // what the server makes of the typed path: the source it belongs to
  useEffect(() => {
    let live = true;
    if (!typed.trim()) {
      setSource(null);
      return undefined;
    }
    api
      .post("/api/v1/paths/resolve", { path: typed })
      .then((r) => live && setSource(r.data.source))
      .catch(() => live && setSource(null));
    return () => {
      live = false;
    };
  }, [typed]);

  const target = source ?? { host: "", userName: "", path: "" };
  const policyState = usePolicy(target, { enabled: !!source?.path });

  const withPolicy = (action) => {
    try {
      return action(policyState.valid());
    } catch (e) {
      setMessage({ kind: "error", text: e.message });
      return undefined;
    }
  };

  const doEstimate = () =>
    withPolicy((policy) =>
      api
        .post("/api/v1/estimate", { root: source.path, maxExamplesPerBucket: 10, policyOverride: policy })
        .then((r) => setEstimate({ id: r.data.id, path: source.path }))
        .catch((e) => setMessage({ kind: "error", text: "Estimate not started: " + errorMessage(e) })),
    );

  const snapshotNow = () =>
    withPolicy((policy) => {
      setBusy(true);
      return api
        .post("/api/v1/sources", { path: source.path, createSnapshot: true, policy })
        .then(() => navigate(-1))
        .catch((e) => {
          setBusy(false);
          setMessage({ kind: "error", text: "Not started: " + errorMessage(e) });
        });
    });

  const ready = !!source?.path;

  return (
    <Page title="New snapshot" trail={[{ label: "Snapshots", to: "/snapshots" }]}>
      {message && (
        <Notice kind={message.kind} onClose={() => setMessage(null)}>
          {message.text}
        </Notice>
      )}
      <Panel title="Folder">
        <Field
          label="Path to back up"
          help={source?.path && source.path !== path.trim() ? `Resolved to ${source.path}` : undefined}
        >
          {(id) => (
            <InputGroup>
              <Form.Control
                id={id}
                autoFocus
                data-testid="control-path"
                placeholder="enter path to snapshot"
                value={path}
                onChange={(e) => setPath(e.target.value)}
              />
              {window.kopiaUI && (
                <Button variant="secondary" onClick={() => window.kopiaUI.selectDirectory(setPath)}>
                  Choose
                </Button>
              )}
            </InputGroup>
          )}
        </Field>
        <div className="nx-row">
          <Button variant="secondary" disabled={!ready} onClick={doEstimate} data-testid="estimate-now">
            Estimate
          </Button>
          <Button variant="primary" disabled={!ready || busy} onClick={snapshotNow} data-testid="snapshot-now">
            Snapshot now
          </Button>
        </div>
      </Panel>
      {estimate && estimate.path === source?.path && <Estimate taskId={estimate.id} />}
      {ready && policyState.loaded && (
        <>
          <h2 className="fs-5">Policy for this folder</h2>
          <PolicyFields target={target} policyState={policyState} />
        </>
      )}
      <CliCommand command={`snapshot create ${source?.path ?? path}`} />
    </Page>
  );
}
