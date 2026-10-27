import React, { useEffect, useState } from "react";
import { formatCount } from "../format";
import Button from "react-bootstrap/Button";
import Spinner from "react-bootstrap/Spinner";
import { Link, useParams } from "react-router";
import { loadSnapshotBrowse } from "../browse";
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
      return <Notice kind="warning">Task canceled.</Notice>;
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

function counterRows(counters) {
  return Object.entries(counters)
    .filter(([, c]) => (c?.value ?? 0) > 0)
    .map(([name, c]) => ({ name, value: c.value, units: c.units, level: c.level ?? "" }))
    .sort((a, b) => (LEVEL_ORDER[b.level] ?? 0) - (LEVEL_ORDER[a.level] ?? 0) || a.name.localeCompare(b.name));
}

export function Task({ taskID }) {
  const params = useParams();
  const id = taskID ?? params.tid;
  const state = useLoad(() => loadTask(id), [id], { refreshMs: 500 });
  const done = !!state.data?.endTime;
  const logs = useLoad(() => loadTaskLogs(id), [id, done], { refreshMs: done ? 0 : 3000 });
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

  const errors = failed.errors || [];
  const unignored = errors.filter((e) => !e.ignored);

  return (
    <Loaded state={state}>
      {(task) => (
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
            </Stats>
          </Panel>
          {task.counters && counterRows(task.counters).length > 0 && (
            <DataTable
              label="counters"
              data={counterRows(task.counters)}
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
          <Panel title="Log">
            <Loaded state={logs}>{(l) => <LogView logs={l} />}</Loaded>
          </Panel>
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
      )}
    </Loaded>
  );
}
