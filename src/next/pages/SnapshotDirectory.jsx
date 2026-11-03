import React, { useState } from "react";
import { copyText } from "../format";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { Link, useLocation, useParams } from "react-router";
import { errorMessage } from "../api";
import {
  browseTrail,
  entryLink,
  entrySize,
  loadDirectory,
  loadMount,
  loadSnapshotTask,
  mountDirectory,
  unmountDirectory,
  useSnapshotDiff,
} from "../browse";
import { useLoad } from "../hooks";
import {
  CountText,
  DataTable,
  DateTimeText,
  FailedBadge,
  FailedFilesDialog,
  FromLink,
  Loaded,
  Notice,
  Page,
  SizeText,
  Toolbar,
} from "../ui";

/** What snapshot is being browsed: when, how big, and what changed since the one before it. */
function SnapshotFacts({ snapshot, taskId }) {
  const diff = useSnapshotDiff(snapshot);
  const n = (v) => (diff.data ? <CountText n={v} /> : diff.loading ? "…" : "—");
  return (
    <div className="nx-facts" data-testid="snapshot-facts">
      <span>
        <span className="nx-muted">Date:</span> <DateTimeText long value={snapshot.startTime} />
      </span>
      <span>
        <span className="nx-muted">Size:</span> <SizeText bytes={snapshot.summary?.size} />
      </span>
      {snapshot.previousId && (
        <>
          <span>
            <span className="nx-muted">Files Added:</span> {n(diff.data?.added)}
          </span>
          <span>
            <span className="nx-muted">Modified:</span> {n(diff.data?.modified)}
          </span>
          <span>
            <span className="nx-muted">Deleted:</span> {n(diff.data?.removed)}
          </span>
        </>
      )}
      {taskId && (
        <FromLink to={"/tasks/" + taskId} data-testid="snapshot-details">
          Details
        </FromLink>
      )}
    </div>
  );
}

export function SnapshotDirectory() {
  const { oid } = useParams();
  const location = useLocation();
  const source = location.state?.snapshot?.source;
  const dir = useLoad(() => loadDirectory(oid, source?.path), [oid, source?.path]);
  const mount = useLoad(() => loadMount(oid), [oid]);
  const snapshotId = location.state?.snapshot?.id;
  const task = useLoad(() => loadSnapshotTask(snapshotId).catch(() => ""), [snapshotId], { enabled: !!snapshotId });
  const [message, setMessage] = useState(null);
  const [failures, setFailures] = useState(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState({});

  const change = (promise, failure) => {
    setBusy(true);
    promise
      .then(mount.reload)
      .catch((e) => setMessage(failure + errorMessage(e)))
      .finally(() => setBusy(false));
  };

  const copy = () => copyText(mount.data.path);

  const columns = [
    {
      id: "name",
      header: "Name",
      accessor: (x) => (x.type === "d" ? "0" : "1") + x.name.toLowerCase(),
      cell: (x) => {
        const l = entryLink(x);
        const label = x.type === "d" ? x.name + "/" : x.name;
        return l.page ? (
          <Link
            to={l.to}
            state={{ label: x.name, oid: x.obj, prevState: location.state, snapshot: location.state?.snapshot }}
          >
            {label}
          </Link>
        ) : (
          <a href={l.href}>{label}</a>
        );
      },
    },
    { id: "mtime", header: "Modified", accessor: (x) => x.mtime, cell: (x) => <DateTimeText value={x.mtime} /> },
    {
      id: "size",
      header: "Size",
      align: "end",
      accessor: (x) => entrySize(x),
      cell: (x) => (
        <>
          <SizeText bytes={entrySize(x)} />
          <FailedBadge
            summ={
              x.summ?.numFailed
                ? { ...x.summ, source: source?.path, userName: source?.userName, host: source?.host }
                : null
            }
            onOpen={setFailures}
          />
        </>
      ),
    },
    {
      id: "files",
      header: "Files",
      align: "end",
      accessor: (x) => x.summ?.files ?? -1,
      cell: (x) => (x.summ ? <CountText n={x.summ.files} /> : ""),
    },
    {
      id: "dirs",
      header: "Folders",
      align: "end",
      accessor: (x) => x.summ?.dirs ?? -1,
      cell: (x) => (x.summ ? <CountText n={x.summ.dirs} /> : ""),
    },
  ];

  const ticked = (dir.data?.entries ?? []).filter((x) => selected[x.obj + x.name]);
  const mounted = mount.data?.path;

  return (
    <Page trail={browseTrail(location.state, oid, { current: true })}>
      {location.state?.snapshot && <SnapshotFacts snapshot={location.state.snapshot} taskId={task.data} />}
      {message && (
        <Notice kind="error" onClose={() => setMessage(null)}>
          {message}
        </Notice>
      )}
      <Toolbar>
        <Toolbar.Group>
          <Button
            as={FromLink}
            variant="primary"
            to={"/snapshots/dir/" + oid + "/restore"}
            state={{ ...location.state, items: ticked.map((x) => ({ obj: x.obj, name: x.name })) }}
            data-testid="restore"
          >
            {ticked.length ? `Restore ${ticked.length} selected` : "Restore all"}
          </Button>
          {!mounted && (
            <Button variant="secondary" disabled={busy} onClick={() => change(mountDirectory(oid), "Not mounted: ")}>
              Mount to browse
            </Button>
          )}
        </Toolbar.Group>
        {mounted && (
          <Toolbar.Group label="Mounted at" grow>
            <Form.Control size="sm" readOnly aria-label="Mounted path" className="mounted-path" value={mounted} />
            <Button size="sm" variant="secondary" onClick={copy} data-testid="copy-path-button">
              Copy
            </Button>
            {window.kopiaUI && (
              <Button size="sm" variant="secondary" onClick={() => window.kopiaUI.browseDirectory(mounted)}>
                Open
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => change(unmountDirectory(oid), "Not unmounted: ")}
            >
              Unmount
            </Button>
          </Toolbar.Group>
        )}
      </Toolbar>
      <Loaded state={dir}>
        {(d) => (
          <DataTable
            label="folder contents"
            data={d.entries || []}
            columns={columns}
            getRowId={(x) => x.obj + x.name}
            selection={{ selected, onChange: setSelected }}
            initialSort={{ id: "name", desc: false }}
            emptyText="This folder is empty."
          />
        )}
      </Loaded>
      {failures && <FailedFilesDialog summ={failures} onClose={() => setFailures(null)} />}
    </Page>
  );
}
