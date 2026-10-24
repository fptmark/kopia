import React, { useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { Link, useLocation, useParams } from "react-router";
import { errorMessage } from "../api";
import { entryLink, entrySize, loadDirectory, loadMount, mountDirectory, unmountDirectory } from "../browse";
import { useLoad } from "../hooks";
import {
  Breadcrumbs,
  CountText,
  DataTable,
  DateTimeText,
  FailedBadge,
  FailedFilesDialog,
  Loaded,
  Notice,
  Page,
  Panel,
  SizeText,
  Toolbar,
} from "../ui";

export function SnapshotDirectory() {
  const { oid } = useParams();
  const location = useLocation();
  const dir = useLoad(() => loadDirectory(oid), [oid]);
  const mount = useLoad(() => loadMount(oid), [oid]);
  const [message, setMessage] = useState(null);
  const [failures, setFailures] = useState(null);
  const [busy, setBusy] = useState(false);

  const change = (promise, failure) => {
    setBusy(true);
    promise
      .then(mount.reload)
      .catch((e) => setMessage(failure + errorMessage(e)))
      .finally(() => setBusy(false));
  };

  const copy = () => navigator.clipboard?.writeText(mount.data.path).catch(() => {});

  const columns = [
    {
      id: "name",
      header: "Name",
      accessor: (x) => (x.type === "d" ? "0" : "1") + x.name.toLowerCase(),
      cell: (x) => {
        const l = entryLink(x);
        const label = x.type === "d" ? x.name + "/" : x.name;
        return l.page ? (
          <Link to={l.to} state={{ label: x.name, oid: x.obj, prevState: location.state }}>
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
          <FailedBadge summ={x.summ?.numFailed ? x.summ : null} onOpen={setFailures} />
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

  return (
    <Page
      title="Browse"
      back
      backLabel="Back"
      actions={
        <Button as={Link} variant="primary" to={"/snapshots/dir/" + oid + "/restore"} state={location.state}>
          Restore files and folders
        </Button>
      }
    >
      <Breadcrumbs />
      {message && (
        <Notice kind="error" onClose={() => setMessage(null)}>
          {message}
        </Notice>
      )}
      <Panel
        title="Use these files"
        note="Restore all of what is listed, mount it to browse it like a drive, or restore single files from the list."
      >
        <Loaded state={mount}>
          {(m) =>
            m.path ? (
              <Toolbar>
                <Toolbar.Group label="Mounted at" grow>
                  <Form.Control size="sm" readOnly aria-label="Mounted path" className="mounted-path" value={m.path} />
                  <Button size="sm" variant="secondary" onClick={copy} data-testid="copy-path-button">
                    Copy
                  </Button>
                  {window.kopiaUI && (
                    <Button size="sm" variant="secondary" onClick={() => window.kopiaUI.browseDirectory(m.path)}>
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
              </Toolbar>
            ) : (
              <Button variant="secondary" disabled={busy} onClick={() => change(mountDirectory(oid), "Not mounted: ")}>
                Mount as local filesystem
              </Button>
            )
          }
        </Loaded>
      </Panel>
      <Loaded state={dir}>
        {(d) => (
          <DataTable
            label="folder contents"
            data={d.entries || []}
            columns={columns}
            getRowId={(x) => x.obj + x.name}
            initialSort={{ id: "name", desc: false }}
            emptyText="This folder is empty."
          />
        )}
      </Loaded>
      {failures && <FailedFilesDialog summ={failures} onClose={() => setFailures(null)} />}
    </Page>
  );
}
