import React, { use, useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import Spinner from "react-bootstrap/Spinner";
import { Link } from "react-router";
import { SnapshotFrequency } from "../../components/SnapshotFrequency";
import { UIPreferencesContext } from "../../contexts/UIPreferencesContext";
import { policyEditorURL } from "../../utils/policyutil";
import { errorMessage } from "../api";
import { useLoad } from "../hooks";
import {
  cancelSnapshot,
  failedSummary,
  isOverdue,
  loadSources,
  ownerName,
  sourceQueryStringParams,
  startSnapshot,
  syncRepository,
  uploadProgress,
} from "../snapshots";
import {
  DataTable,
  DateTimeText,
  FailedBadge,
  FailedFilesDialog,
  Loaded,
  Notice,
  Page,
  SizeText,
  StatusBadge,
  Toolbar,
} from "../ui";

const LOCAL = "local";
const ALL = "all";

function SourceActions({ row, onStart, onCancel, base2 }) {
  switch (row.status) {
    case "PENDING":
      return (
        <span title="Starts after the previous snapshot finishes">
          <Spinner animation="border" size="sm" variant="secondary" data-testid="snapshot-pending" /> Pending
        </span>
      );
    case "UPLOADING":
      return (
        <span className="d-inline-flex align-items-center gap-2" data-testid="snapshot-uploading">
          <Spinner animation="border" size="sm" variant="primary" />
          <span className="nx-num" title={row.upload?.directory}>
            {uploadProgress(row.upload, base2)}
          </span>
          {row.currentTask && <Link to={"/tasks/" + row.currentTask}>Details</Link>}
          <Button size="sm" variant="secondary" onClick={() => onCancel(row.source)}>
            Cancel
          </Button>
        </span>
      );
    default:
      return (
        <span className="d-inline-flex gap-2">
          <Button as={Link} size="sm" variant="secondary" to={policyEditorURL(row.source)} data-testid="edit-policy">
            Policy
          </Button>
          <Button size="sm" variant="primary" data-testid="snapshot-now" onClick={() => onStart(row.source)}>
            Snapshot now
          </Button>
        </span>
      );
  }
}

export function Snapshots() {
  const prefs = use(UIPreferencesContext);
  const state = useLoad(loadSources, [], { refreshMs: 3000 });
  const [owner, setOwner] = useState(prefs.defaultSnapshotViewAll ? ALL : LOCAL);
  const [failures, setFailures] = useState(null);
  const [message, setMessage] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const base2 = !!prefs.bytesStringBase2;

  const act = (promise, failure) =>
    promise.then(state.refresh).catch((e) => setMessage({ kind: "error", text: failure + errorMessage(e) }));

  const sync = () => {
    setSyncing(true);
    syncRepository()
      .then(state.refresh)
      .catch((e) => setMessage({ kind: "error", text: "Not synchronized: " + errorMessage(e) }))
      .finally(() => setSyncing(false));
  };

  const chooseOwner = (value) => {
    setOwner(value);
    prefs.setDefaultSnapshotViewAll?.(value === ALL);
  };

  return (
    <Page
      title="Snapshots"
      subtitle="Each folder that is backed up. Open one to see its snapshots."
      actions={
        <>
          <Button variant="secondary" onClick={sync} disabled={syncing} title="Fetch the latest from the repository">
            {syncing ? "Synchronizing" : "Synchronize"}
          </Button>
          <Button as={Link} variant="primary" to="/snapshots/new" data-testid="new-snapshot">
            New snapshot
          </Button>
        </>
      }
    >
      {message && (
        <Notice kind={message.kind} onClose={() => setMessage(null)}>
          {message.text}
        </Notice>
      )}
      <Loaded state={state}>
        {(d) => {
          const local = d.localUsername + "@" + d.localHost;
          const rows = d.sources.filter((r) => owner === ALL || ownerName(r.source) === local);
          const showOwner = d.multiUser && owner === ALL;

          const columns = [
            {
              id: "path",
              header: "Folder",
              accessor: (r) => r.source.path,
              cell: (r) => (
                <Link
                  to={"/snapshots/single-source?" + sourceQueryStringParams(r.source)}
                  title="Show the snapshots of this folder"
                >
                  <span className="nx-path">{r.source.path}</span> {"›"}
                </Link>
              ),
            },
            ...(showOwner ? [{ id: "owner", header: "Owner", accessor: (r) => ownerName(r.source) }] : []),
            {
              id: "size",
              header: () => (
                <span title="Total size of the files in the newest snapshot, before deduplication and compression.">
                  Logical size
                </span>
              ),
              align: "end",
              accessor: (r) => r.lastSnapshot?.stats?.totalSize ?? -1,
              cell: (r) =>
                r.lastSnapshot ? (
                  <>
                    <SizeText bytes={r.lastSnapshot.stats?.totalSize} />
                    <FailedBadge summ={failedSummary(r)} onOpen={setFailures} />
                  </>
                ) : (
                  <span className="nx-muted">{"—"}</span>
                ),
            },
            {
              id: "last",
              header: "Last snapshot",
              accessor: (r) => r.lastSnapshot?.startTime ?? "",
              cell: (r) => {
                const t = r.lastSnapshot?.startTime;
                const paused = r.status === "PAUSED";
                return (
                  <span className="d-inline-flex align-items-center gap-2">
                    {t ? <DateTimeText value={t} ago /> : <span className="nx-muted">none yet</span>}
                    {paused && <StatusBadge kind="warning">paused</StatusBadge>}
                    {!paused && isOverdue(t, r.schedule?.intervalSeconds) && (
                      <StatusBadge kind="error">overdue</StatusBadge>
                    )}
                  </span>
                );
              },
            },
            {
              id: "actions",
              header: "",
              align: "end",
              cell: (r) => (
                <SourceActions
                  row={r}
                  base2={base2}
                  onStart={(s) => act(startSnapshot(s), "Not started: ")}
                  onCancel={(s) => act(cancelSnapshot(s), "Not cancelled: ")}
                />
              ),
            },
          ];

          return (
            <>
              <Toolbar>
                {d.multiUser && (
                  <Toolbar.Group label="Show">
                    <Form.Select
                      size="sm"
                      aria-label="Owner"
                      value={owner}
                      onChange={(e) => chooseOwner(e.target.value)}
                    >
                      <option value={LOCAL}>{local}</option>
                      <option value={ALL}>Everyone</option>
                    </Form.Select>
                  </Toolbar.Group>
                )}
                <Toolbar.Group label="Schedule">
                  <SnapshotFrequency sources={d.sources} onSaved={state.refresh} />
                </Toolbar.Group>
              </Toolbar>
              <DataTable
                label="snapshot sources"
                data={rows}
                columns={columns}
                getRowId={(r) => ownerName(r.source) + ":" + r.source.path}
                initialSort={{ id: "path", desc: false }}
                emptyText="Nothing is backed up yet. Use New snapshot to add a folder."
              />
            </>
          );
        }}
      </Loaded>
      {failures && <FailedFilesDialog summ={failures} onClose={() => setFailures(null)} />}
    </Page>
  );
}
