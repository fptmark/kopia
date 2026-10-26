import React, { use, useEffect, useRef, useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import InputGroup from "react-bootstrap/InputGroup";
import Spinner from "react-bootstrap/Spinner";
import { SetupRepository } from "../../components/SetupRepository";
import { AppContext } from "../../contexts/AppContext";
import { errorMessage } from "../api";
import { NextContext } from "../context";
import { formatDateTime } from "../format";
import { useLoad } from "../hooks";
import { cancelTask } from "../tasks";
import { clock, disconnectRepo, loadRepoStatus, loadStorageUsage, repoFacts, setRepoDescription } from "../repository";
import {
  BackupHealth,
  CliCommand,
  ConfirmDialog,
  CountText,
  DataTable,
  Field,
  Loaded,
  LogView,
  Notice,
  Page,
  Panel,
  SizeText,
  StatusBadge,
} from "../ui";
import { loadTaskLogs } from "../tasks";

/** The size of the repository on storage. Listing every blob can take minutes, so it only runs when asked. */
function StorageUsage() {
  const [usage, setUsage] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef(null);
  const startedAt = useRef(0);

  const stop = () => {
    window.clearInterval(timer.current);
    timer.current = null;
  };

  const read = (refresh) =>
    loadStorageUsage(refresh)
      .then((d) => {
        const calculated = d.blobCount > 0 || d.totalBytes > 0;
        setUsage(calculated ? d : null);
        setRunning(!!d.running);
        setError(d.running ? "" : d.error || "");
        if (d.running && !timer.current) {
          startedAt.current = d.startedAt ? Date.parse(d.startedAt) : Date.now();
          let ticks = 0;
          timer.current = window.setInterval(() => {
            ticks++;
            setElapsed(Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000)));
            if (ticks % 2 === 0) {
              read(false);
            }
          }, 1000);
        } else if (!d.running) {
          stop();
        }
      })
      .catch((e) => {
        if (refresh) {
          stop();
          setRunning(false);
          setError(errorMessage(e));
        }
      });

  useEffect(() => {
    read(false);
    return stop;
    // runs once; read polls itself while a calculation is running
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  return (
    <div className="d-flex flex-wrap align-items-center gap-3" data-testid="storage-usage">
      {running ? (
        <span>
          <Spinner animation="border" size="sm" /> Calculating, {clock(elapsed)} elapsed. Every file on the storage is
          listed, which can take a few minutes.
        </span>
      ) : error ? (
        <span className="text-danger">Error: {error}</span>
      ) : usage ? (
        <span>
          <SizeText bytes={usage.totalBytes} /> in <CountText n={usage.blobCount} /> blobs{" "}
          <span className="nx-muted">(as of {formatDateTime(usage.computedAt)})</span>
        </span>
      ) : (
        <span className="nx-muted">Not calculated yet.</span>
      )}
      <Button
        variant="secondary"
        size="sm"
        disabled={running}
        data-testid="refresh-storage-usage"
        onClick={() => {
          setRunning(true);
          setError("");
          setElapsed(0);
          read(true);
        }}
      >
        {usage ? "Refresh" : "Calculate"}
      </Button>
    </div>
  );
}

function Initializing({ taskId }) {
  const [show, setShow] = useState(false);
  const logs = useLoad(() => loadTaskLogs(taskId), [taskId], { refreshMs: 3000, enabled: show });

  return (
    <Panel title="Connecting to the repository" actions={<Spinner animation="border" size="sm" />}>
      <div className="d-flex gap-2 mb-3">
        <Button variant="secondary" onClick={() => setShow(!show)}>
          {show ? "Hide log" : "Show log"}
        </Button>
        <Button variant="danger" onClick={() => cancelTask(taskId)}>
          Cancel connection
        </Button>
      </div>
      {show && <Loaded state={logs}>{(l) => <LogView logs={l} />}</Loaded>}
    </Panel>
  );
}

export function Repository() {
  const shell = use(NextContext);
  const state = useLoad(loadRepoStatus, [], { refreshMs: 3000 });
  const [description, setDescription] = useState(null);
  const [message, setMessage] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const status = state.data;
  const shown = description ?? status?.description ?? "";

  const saveDescription = () => {
    setBusy(true);
    setRepoDescription(shown)
      .then(() => {
        setMessage({ kind: "success", text: "Description saved." });
        setDescription(null);
        shell.refreshRepo();
      })
      .catch((e) => setMessage({ kind: "error", text: "Not saved: " + errorMessage(e) }))
      .finally(() => setBusy(false));
  };

  const disconnect = () => {
    setBusy(true);
    disconnectRepo()
      .then(() => {
        shell.refreshRepo();
        state.reload();
      })
      .catch((e) => setMessage({ kind: "error", text: "Not disconnected: " + errorMessage(e) }))
      .finally(() => {
        setBusy(false);
        setConfirming(false);
      });
  };

  // the old setup wizard calls this when it has connected
  const appContext = {
    repoDescription: "",
    repositoryUpdated: (connected) => {
      shell.refreshRepo();
      window.location.replace(connected ? "/snapshots" : "/repo");
    },
    repositoryDescriptionUpdated: () => shell.refreshRepo(),
  };

  return (
    <Page title="Repository">
      {message && (
        <Notice kind={message.kind} onClose={() => setMessage(null)}>
          {message.text}
        </Notice>
      )}
      <Loaded state={state}>
        {(s) =>
          s.initTaskID ? (
            <Initializing taskId={s.initTaskID} />
          ) : s.connected ? (
            <>
              <Panel title="Connected" actions={<StatusBadge kind="ok">connected</StatusBadge>}>
                {s.readonly && <Notice kind="warning">The repository is read-only.</Notice>}
                <Field label="Description" error={!shown ? "A description is required." : undefined}>
                  {(id) => (
                    <InputGroup>
                      <Form.Control
                        id={id}
                        value={shown}
                        isInvalid={!shown}
                        onChange={(e) => setDescription(e.target.value)}
                      />
                      <Button
                        variant="primary"
                        data-testid="update-description"
                        disabled={busy || !shown || shown === s.description}
                        onClick={saveDescription}
                      >
                        Update description
                      </Button>
                    </InputGroup>
                  )}
                </Field>
                {!s.apiServerURL && (
                  <Field label="Total size on storage" help="After dedup and compression.">
                    {() => <StorageUsage />}
                  </Field>
                )}
                <Field label="Connected as">{() => <span>{s.username + "@" + s.hostname}</span>}</Field>
              </Panel>
              <Panel title="Backup health">
                <BackupHealth />
              </Panel>
              <DataTable
                label="repository details"
                data={repoFacts(s).map(([k, v]) => ({ k, v }))}
                getRowId={(r) => r.k}
                footer={false}
                columns={[
                  { id: "k", header: "Setting", cell: (r) => r.k, width: "16rem" },
                  {
                    id: "v",
                    header: "Value",
                    cell: (r) => <span className={r.k === "Config file" ? "nx-path" : undefined}>{r.v}</span>,
                  },
                ]}
              />
              <Button variant="danger" data-testid="disconnect" disabled={busy} onClick={() => setConfirming(true)}>
                Disconnect
              </Button>
              <CliCommand command="repository status" />
              <ConfirmDialog
                show={confirming}
                title="Disconnect from the repository?"
                confirmLabel="Disconnect"
                danger
                busy={busy}
                onCancel={() => setConfirming(false)}
                onConfirm={disconnect}
              >
                Backups stop until a repository is connected again. Nothing stored is deleted.
              </ConfirmDialog>
            </>
          ) : (
            <AppContext value={appContext}>
              <SetupRepository />
            </AppContext>
          )
        }
      </Loaded>
    </Page>
  );
}
