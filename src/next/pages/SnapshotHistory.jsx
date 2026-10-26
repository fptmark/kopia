import React, { use, useMemo, useState } from "react";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { Link, useLocation, useNavigate } from "react-router";
import { UIPreferencesContext } from "../../contexts/UIPreferencesContext";
import { objectLink } from "../../utils/formatutils";
import { errorMessage } from "../api";
import { formatDate, formatSizeChange } from "../format";
import { useLoad } from "../hooks";
import {
  deleteSnapshots,
  editSnapshots,
  loadHistory,
  loadStorageStats,
  sizeJump,
  sourceFromSearch,
} from "../snapshots";
import {
  ConfirmDialog,
  CountText,
  DataTable,
  DateTimeText,
  Field,
  Loaded,
  Notice,
  Page,
  Panel,
  SizeText,
  Stat,
  Stats,
  StatusBadge,
  Toolbar,
} from "../ui";
import { FailedBadge, FailedFilesDialog, VerifiedCell, VerifyDialog, VerifyFailuresDialog } from "../ui";
import { groupVerifications, loadVerifications, verifySnapshots } from "../verification";

function Retention({ snap, onPin }) {
  return (
    <span className="nx-inline">
      {(snap.retention || []).map((l) => (
        <StatusBadge key={l} kind="neutral">
          {l}
        </StatusBadge>
      ))}
      {(snap.pins || []).map((p) => (
        <button
          key={p}
          type="button"
          className="btn btn-sm nx-icon-btn"
          title="Edit pin"
          onClick={() => onPin(snap, p)}
        >
          <StatusBadge kind="info">pin: {p}</StatusBadge>
        </button>
      ))}
    </span>
  );
}

export function SnapshotHistory() {
  const location = useLocation();
  const navigate = useNavigate();
  const prefs = use(UIPreferencesContext);
  const source = useMemo(() => sourceFromSearch(location.search), [location.search]);
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState({});
  const [message, setMessage] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [alsoSource, setAlsoSource] = useState(false);
  const [edit, setEdit] = useState(null); // {type: "note" | "pin", snap, pin?}
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyFailed, setVerifyFailed] = useState(null);

  const state = useLoad(() => loadHistory(source, showAll), [source, showAll]);
  const stats = useLoad(() => loadStorageStats(source), [source, state.data]);

  const snapshots = useMemo(
    () => [...(state.data?.snapshots ?? [])].sort((a, b) => new Date(b.startTime) - new Date(a.startTime)),
    [state.data],
  );
  const ids = useMemo(() => snapshots.map((s) => s.id), [snapshots]);
  // checked every two seconds so a verification that is running shows its progress and its result
  const verif = useLoad(() => loadVerifications(ids), [ids.join(",")], { enabled: ids.length > 0, refreshMs: 2000 });
  const verified = useMemo(() => groupVerifications(verif.data), [verif.data]);
  const statById = useMemo(() => Object.fromEntries((stats.data?.snapshots ?? []).map((s) => [s.id, s])), [stats.data]);
  const stored = (stats.data?.snapshots ?? []).reduce((n, s) => n + s.newBytes, 0);
  const chosen = snapshots.filter((s) => selected[s.id]);

  const report = (kind, t) => setMessage({ kind, text: t });
  const afterChange = () => {
    setSelected({});
    state.reload();
  };

  const remove = () => {
    setBusy(true);
    deleteSnapshots(
      source,
      chosen.map((s) => s.id),
      alsoSource,
    )
      .then(() => {
        if (alsoSource) {
          navigate("/snapshots");
          return;
        }
        report(
          "success",
          `Deleted ${chosen.length} ${chosen.length === 1 ? "snapshot" : "snapshots"}. The space is freed when maintenance next runs.`,
        );
        afterChange();
      })
      .catch((e) => report("error", "Not deleted: " + errorMessage(e)))
      .finally(() => {
        setBusy(false);
        setConfirmDelete(false);
      });
  };

  const saveEdit = (req) => {
    setBusy(true);
    editSnapshots(req)
      .then(() => {
        setEdit(null);
        state.reload();
      })
      .catch((e) => report("error", "Not saved: " + errorMessage(e)))
      .finally(() => setBusy(false));
  };

  const startVerify = (mode, percent) => {
    setBusy(true);
    verifySnapshots(
      chosen.map((s) => s.id),
      mode,
      percent,
    )
      .then((r) => {
        const n = r.started.length;
        report(
          "success",
          n
            ? `Verifying ${n} ${n === 1 ? "snapshot" : "snapshots"}, one at a time. Progress shows in the Verified column and on the Tasks page.`
            : "Those verifications are already queued or running.",
        );
        setVerifying(false);
        verif.reload();
      })
      .catch((e) => report("error", "Not started: " + errorMessage(e)))
      .finally(() => setBusy(false));
  };

  const compare = () => {
    const [a, b] = [...chosen].sort((x, y) => new Date(x.startTime) - new Date(y.startTime));
    navigate("/snapshots/diff?from=" + a.id + "&to=" + b.id);
  };

  const columns = [
    {
      id: "start",
      header: "Snapshot",
      accessor: (s) => s.startTime,
      cell: (s) => (
        <>
          <Link
            to={objectLink(s.rootID)}
            state={{
              label: source.path,
              snapshot: { ...s, source, previousId: snapshots[snapshots.indexOf(s) + 1]?.id },
            }}
            title="Browse this snapshot"
          >
            <DateTimeText value={s.startTime} />
          </Link>
        </>
      ),
    },
    {
      id: "retention",
      header: "Kept as",
      cell: (s) => (
        <Retention
          snap={s}
          onPin={(snap, pin) => {
            setText(pin);
            setEdit({ type: "pin", snap, pin });
          }}
        />
      ),
    },
    {
      id: "size",
      header: () => <span title="Before dedup and compression">Logical size</span>,
      align: "end",
      accessor: (s) => s.summary?.size ?? 0,
      cell: (s) => {
        const i = snapshots.indexOf(s);
        const jump = sizeJump(s.summary?.size, snapshots[i + 1]?.summary?.size);
        return (
          <span className="nx-inline">
            {jump !== null && (
              <span
                className={jump > 0 ? "text-warning" : "nx-muted"}
                data-testid="size-jump"
                title={`Logical size changed by ${formatSizeChange(jump, !!prefs.bytesStringBase2)} compared with the previous snapshot.`}
              >
                {"⚠"} {formatSizeChange(jump, !!prefs.bytesStringBase2)}
              </span>
            )}
            <SizeText bytes={s.summary?.size} />
          </span>
        );
      },
    },
    {
      id: "new",
      header: () => <span title="Compressed data this snapshot added">New data</span>,
      align: "end",
      accessor: (s) => statById[s.id]?.newBytes ?? -1,
      cell: (s) => {
        if (stats.loading && !stats.data) {
          return <span className="nx-muted">{"…"}</span>;
        }
        const st = statById[s.id];
        return st ? (
          <span title={`${st.newFiles} new files, ${st.newDirs} new folders`}>
            <SizeText bytes={st.newBytes} />
          </span>
        ) : (
          <span className="nx-muted">{"—"}</span>
        );
      },
    },
    {
      id: "result",
      header: () => <span title="Click a failure for the files">Result</span>,
      cell: (s) =>
        s.summary?.numFailed ? (
          <FailedBadge
            summ={{ ...s.summary, source: source.path, userName: source.userName, host: source.host }}
            onOpen={setFailures}
          />
        ) : (
          <StatusBadge kind="ok">OK</StatusBadge>
        ),
    },
    {
      id: "verified",
      header: () => <span title="Last read-back from the NAS">Verified</span>,
      cell: (s) => <VerifiedCell info={verified[s.id]} onShowFailures={setVerifyFailed} />,
    },
    {
      id: "files",
      header: "Files",
      align: "end",
      accessor: (s) => s.summary?.files ?? 0,
      cell: (s) => <CountText n={s.summary?.files ?? 0} />,
    },
    {
      id: "dirs",
      header: "Folders",
      align: "end",
      accessor: (s) => s.summary?.dirs ?? 0,
      cell: (s) => <CountText n={s.summary?.dirs ?? 0} />,
    },
    {
      id: "actions",
      header: "",
      align: "end",
      cell: (s) => (
        <Button
          size="sm"
          variant={s.description ? "primary" : "secondary"}
          aria-label={"Note for " + s.id}
          title={s.description || "Add a note"}
          onClick={() => {
            setText(s.description || "");
            setEdit({ type: "note", snap: s });
          }}
        >
          {"✎"}
        </Button>
      ),
    },
  ];

  return (
    <Page
      title="History"
      subtitle={
        <>
          <span className="nx-path">{source.path}</span>{" "}
          <span className="nx-muted">
            {source.userName}@{source.host}
          </span>
        </>
      }
      trail={[{ label: "Snapshots", to: "/snapshots" }]}
    >
      {message && (
        <Notice kind={message.kind} onClose={() => setMessage(null)}>
          {message.text}
        </Notice>
      )}
      <Loaded state={state}>
        {(d) => (
          <>
            <Panel>
              <Stats data-testid="history-summary">
                <Stat
                  label="Snapshots"
                  value={snapshots.length}
                  note={
                    d.unfilteredCount !== d.uniqueCount ? `${d.unfilteredCount} counting identical ones` : undefined
                  }
                />
                <Stat label="Latest" value={<SizeText bytes={snapshots[0]?.summary?.size} />} note="logical size" />
                <Stat
                  label="Size on Disk"
                  value={stats.data ? <SizeText bytes={stored} /> : "…"}
                  note="after deduplication and compression"
                />
                <Stat
                  label="Oldest"
                  value={snapshots.length ? formatDate(snapshots[snapshots.length - 1].startTime) : "—"}
                />
              </Stats>
            </Panel>

            <Toolbar>
              <Toolbar.Group label="Show">
                <Form.Check
                  type="checkbox"
                  id="show-identical"
                  label={`Identical snapshots too (${d.unfilteredCount})`}
                  checked={showAll}
                  disabled={d.unfilteredCount === d.uniqueCount && !showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                />
              </Toolbar.Group>
              <Toolbar.Group label="Selected" end>
                <span className={chosen.length ? "" : "nx-muted"}>{chosen.length === 0 ? "none" : chosen.length}</span>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={chosen.length !== 2}
                  onClick={compare}
                  title="Select two snapshots"
                >
                  Compare
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={chosen.length === 0}
                  onClick={() => setVerifying(true)}
                  title="Read the selected snapshots back"
                >
                  Verify
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={chosen.length === 0}
                  onClick={() => {
                    setAlsoSource(false);
                    setConfirmDelete(true);
                  }}
                >
                  Delete
                </Button>
              </Toolbar.Group>
            </Toolbar>

            <DataTable
              label="snapshots"
              oneLine
              data={snapshots}
              columns={columns}
              getRowId={(s) => s.id}
              selection={{ selected, onChange: setSelected }}
              initialSort={{ id: "start", desc: true }}
              emptyText="This folder has no snapshots."
            />
            {snapshots.length === 0 && (
              <Button
                variant="danger"
                onClick={() => {
                  setAlsoSource(true);
                  setConfirmDelete(true);
                }}
                data-testid="delete-source"
              >
                Remove this folder and its policy
              </Button>
            )}
          </>
        )}
      </Loaded>

      {verifying && (
        <VerifyDialog count={chosen.length} busy={busy} onStart={startVerify} onCancel={() => setVerifying(false)} />
      )}
      {verifyFailed && <VerifyFailuresDialog verification={verifyFailed} onClose={() => setVerifyFailed(null)} />}

      <ConfirmDialog
        show={confirmDelete}
        title={alsoSource && chosen.length === 0 ? "Remove this folder?" : "Delete snapshots?"}
        confirmLabel="Delete"
        danger
        busy={busy}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={remove}
      >
        {chosen.length > 0 ? (
          <p>
            Delete <b>{chosen.length}</b> selected {chosen.length === 1 ? "snapshot" : "snapshots"} of{" "}
            <span className="nx-path">{source.path}</span>? This cannot be undone.
          </p>
        ) : (
          <p>
            Remove <span className="nx-path">{source.path}</span> from the list, with its policy?
          </p>
        )}
        {chosen.length > 0 && chosen.length === snapshots.length && (
          <Form.Check
            type="checkbox"
            id="also-source"
            label="Also remove this folder and its policy."
            checked={alsoSource}
            onChange={(e) => setAlsoSource(e.target.checked)}
          />
        )}
      </ConfirmDialog>

      <ConfirmDialog
        show={edit?.type === "note"}
        title="Note on this snapshot"
        confirmLabel="Save"
        busy={busy}
        disabled={edit && text === (edit.snap.description || "")}
        onCancel={() => setEdit(null)}
        onConfirm={() => saveEdit({ snapshots: [edit.snap.id], description: text })}
      >
        <Field label="Note">
          {(id) => (
            <Form.Control id={id} as="textarea" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
          )}
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        show={edit?.type === "pin"}
        title={edit?.pin ? "Pin" : "Pin this snapshot"}
        confirmLabel={edit?.pin ? "Update" : "Pin"}
        busy={busy}
        disabled={!text || (edit && text === edit.pin)}
        onCancel={() => setEdit(null)}
        onConfirm={() =>
          saveEdit({ snapshots: [edit.snap.id], addPins: [text], removePins: edit.pin ? [edit.pin] : [] })
        }
      >
        <Field label="Name of the pin" help="Never expires.">
          {(id) => <Form.Control id={id} value={text} onChange={(e) => setText(e.target.value)} />}
        </Field>
        {edit?.pin && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => saveEdit({ snapshots: [edit.snap.id], removePins: [edit.pin] })}
          >
            Remove this pin
          </Button>
        )}
      </ConfirmDialog>

      {failures && <FailedFilesDialog summ={failures} onClose={() => setFailures(null)} />}
    </Page>
  );
}
