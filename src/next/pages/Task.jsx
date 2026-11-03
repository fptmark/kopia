import React, { useEffect, useState } from "react";
import { formatCount } from "../format";
import Button from "react-bootstrap/Button";
import Spinner from "react-bootstrap/Spinner";
import { Link, useParams } from "react-router";
import { loadSnapshotBrowse, useSnapshotDiff } from "../browse";
import { useLoad } from "../hooks";
import {
  cancelTask,
  isRunning,
  loadTask,
  loadTaskErrors,
  loadTaskLogs,
  shortTaskError,
  taskDuration,
  taskErrorHint,
  TaskStatus,
} from "../tasks";
import {
  CountText,
  DataTable,
  DateTimeText,
  FailedFilesDialog,
  Loaded,
  LogView,
  Notice,
  Page,
  Panel,
  SizeText,
  Stat,
  Stats,
} from "../ui";

const LEVEL_ORDER = { error: 30, notice: 10, warning: 5 };

function Summary({ task }) {
  const d = taskDuration(task);
  switch (task.status) {
    case TaskStatus.SUCCESS:
      return <Notice kind="success">Task succeeded after {d}.</Notice>;
    case TaskStatus.FAILED:
      return (
        <Notice kind="error" data-testid="task-error" title="Error:">
          {shortTaskError(task.errorMessage)}
          {taskErrorHint(task.errorMessage) && <div>{taskErrorHint(task.errorMessage)}</div>}
          <details>
            <summary>Full message</summary>
            <pre className="text-break" style={{ whiteSpace: "pre-wrap" }}>
              {task.errorMessage}
            </pre>
          </details>
        </Notice>
      );
    case TaskStatus.CANCELED:
      return task.cancelReason ? (
        <Notice kind="warning">Aborted: {task.cancelReason}.</Notice>
      ) : (
        <Notice kind="warning">Task canceled.</Notice>
      );
    case TaskStatus.CANCELING:
      return (
        <Notice kind="warning">
          <Spinner animation="border" size="sm" /> Canceling {d}: {task.progressInfo}.
        </Notice>
      );
    default:
      return (
        <Notice kind="info">
          <Spinner animation="border" size="sm" /> Running for {d}: {task.progressInfo}.
        </Notice>
      );
  }
}

// a sensible, stable reading order for the matrix's columns -- counters come back as a JSON object (a Go
// map underneath), with no guaranteed order of its own. Anything not listed here sorts after, alphabetically.
const CATEGORY_ORDER = ["Cached", "Hashed", "Processed", "Uploaded", "Excluded", "Estimated"];

/**
 * Splits a task's counters into a Files/Bytes-by-category matrix -- every pair of counters literally named
 * "<Category> Files" and/or "<Category> Bytes" (Snapshot's Cached/Hashed/Processed/Uploaded/Excluded/
 * Estimated) becomes one column -- and everything that doesn't fit that shape (Verify's counters, Errors,
 * Excluded Directories, ...) as flat "other" rows. Name-pattern-driven rather than hardcoded per task kind,
 * so it naturally does the right thing for a kind with no category axis at all: everything just falls into
 * "other".
 */
function splitCounters(counters) {
  const byCategory = new Map(); // category -> { Files: CounterValue, Bytes: CounterValue }
  const other = [];

  for (const [name, c] of Object.entries(counters)) {
    if ((c?.value ?? 0) <= 0) {
      continue;
    }
    const m = /^(.+) (Files|Bytes)$/.exec(name);
    if (m) {
      const [, category, kind] = m;
      const row = byCategory.get(category) || {};
      row[kind] = c;
      byCategory.set(category, row);
    } else {
      other.push({ name, value: c.value, units: c.units, level: c.level ?? "" });
    }
  }

  const categories = [...byCategory.keys()].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) {
      return a.localeCompare(b);
    }
    return (ia === -1 ? CATEGORY_ORDER.length : ia) - (ib === -1 ? CATEGORY_ORDER.length : ib);
  });

  other.sort((a, b) => (LEVEL_ORDER[b.level] ?? 0) - (LEVEL_ORDER[a.level] ?? 0) || a.name.localeCompare(b.name));

  return { byCategory, categories, other };
}

export function Task({ taskID }) {
  const params = useParams();
  const id = taskID ?? params.tid;
  const state = useLoad(() => loadTask(id), [id], { refreshMs: 500 });
  const done = !!state.data?.endTime;
  const [showLog, setShowLog] = useState(false);
  const logs = useLoad(() => loadTaskLogs(id), [id, done], { refreshMs: done ? 0 : 3000, enabled: showLog });
  const [failed, setFailed] = useState({ errors: [], source: undefined });
  const [open, setOpen] = useState(false);
  const isSnapshot = state.data?.kind === "Snapshot";

  useEffect(() => {
    if (isSnapshot && done) {
      loadTaskErrors(id)
        .then((r) => setFailed(r))
        .catch(() => {});
    }
  }, [id, isSnapshot, done]);

  // a snapshot task links to the snapshot it made
  const source = failed.source ? { host: failed.host, userName: failed.userName, path: failed.source } : null;
  const made = useLoad(() => loadSnapshotBrowse(source, failed.snapshotId), [id, failed.snapshotId], {
    enabled: !!(source && failed.snapshotId),
  });
  const snapshot = made.data?.state?.snapshot;
  const diff = useSnapshotDiff(snapshot);
  const n = (v) => (diff.data ? <CountText n={v} /> : diff.loading ? "…" : "—");

  const errors = failed.errors || [];
  const unignored = errors.filter((e) => !e.ignored);

  return (
    <Loaded state={state}>
      {(task) => {
        const { categories, byCategory, other } = task.counters
          ? splitCounters(task.counters)
          : { categories: [], byCategory: new Map(), other: [] };
        const matrixRows = categories.length > 0 ? ["Files", "Bytes"].map((kind) => ({ kind })) : [];

        return (
        <Page
          title={`${task.kind}: ${task.description}`}
          trail={[{ label: "Tasks", to: "/tasks" }]}
          crumb="Details"
          actions={
            <>
              {made.data && (
                <Button as={Link} variant="secondary" {...made.data}>
                  View snapshot
                </Button>
              )}
              {isRunning(task) && (
                <Button variant="danger" onClick={() => cancelTask(task.id)}>
                  Stop
                </Button>
              )}
            </>
          }
        >
          <Summary task={task} />
          {errors.length > 0 && (
            <Notice kind={unignored.length ? "warning" : "info"}>
              <span className="nx-inline">
                <span data-testid="failed-files-summary">
                  {unignored.length > 0 && (
                    <>
                      {formatCount(unignored.length)} {unignored.length === 1 ? "file" : "files"} could not be backed
                      up.
                    </>
                  )}
                  {errors.length - unignored.length > 0 && (
                    <span className={unignored.length ? "nx-muted" : undefined}>
                      {unignored.length > 0 ? " " : ""}
                      {formatCount(errors.length - unignored.length)} ignored.
                    </span>
                  )}
                </span>
                <Button size="sm" variant="primary" data-testid="show-failed-files" onClick={() => setOpen(true)}>
                  Show details
                </Button>
              </span>
            </Notice>
          )}
          <Panel>
            <Stats>
              <Stat label="Started" value={<DateTimeText long value={task.startTime} />} />
              <Stat
                label="Finished"
                value={task.endTime ? <DateTimeText long value={task.endTime} /> : "still running"}
              />
              <Stat label="Took" value={taskDuration(task)} />
              {snapshot && (
                <>
                  <Stat label="Size" value={<SizeText bytes={snapshot.summary?.size} />} />
                  {snapshot.previousId && (
                    <>
                      <Stat label="Files Added" value={n(diff.data?.added)} />
                      <Stat label="Modified" value={n(diff.data?.modified)} />
                      <Stat label="Deleted" value={n(diff.data?.removed)} />
                    </>
                  )}
                </>
              )}
            </Stats>
          </Panel>
          {matrixRows.length > 0 && (
            <DataTable
              label="counters"
              data={matrixRows}
              getRowId={(r) => r.kind}
              footer={false}
              columns={[
                { id: "kind", header: "", accessor: (r) => r.kind },
                ...categories.map((cat) => ({
                  id: cat,
                  header: cat,
                  align: "end",
                  accessor: (r) => byCategory.get(cat)?.[r.kind]?.value ?? -1,
                  cell: (r) => {
                    const c = byCategory.get(cat)?.[r.kind];
                    return c ? (
                      r.kind === "Bytes" ? (
                        <SizeText bytes={c.value} />
                      ) : (
                        formatCount(c.value)
                      )
                    ) : (
                      <span className="nx-muted">—</span>
                    );
                  },
                })),
              ]}
            />
          )}
          {other.length > 0 && (
            <DataTable
              label="other counters"
              data={other}
              getRowId={(r) => r.name}
              footer={false}
              columns={[
                { id: "name", header: "Counter", accessor: (r) => r.name },
                {
                  id: "value",
                  header: "Value",
                  align: "end",
                  accessor: (r) => r.value,
                  cell: (r) => (r.units === "bytes" ? <SizeText bytes={r.value} /> : formatCount(r.value)),
                },
              ]}
            />
          )}
          {showLog ? (
            <Panel title="Log">
              <Loaded state={logs}>{(l) => <LogView logs={l} />}</Loaded>
            </Panel>
          ) : (
            <Button variant="link" className="nx-link-button" onClick={() => setShowLog(true)}>
              Show log
            </Button>
          )}
          {open && (
            <FailedFilesDialog
              summ={{
                numFailed: unignored.length,
                ignored: errors.length - unignored.length,
                errors,
                source: failed.source,
                userName: failed.userName,
                host: failed.host,
                taskId: id,
              }}
              onClose={() => setOpen(false)}
            />
          )}
        </Page>
        );
      }}
    </Loaded>
  );
}
