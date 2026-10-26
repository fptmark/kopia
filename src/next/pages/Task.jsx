import React, { useEffect, useState } from "react";
import Button from "react-bootstrap/Button";
import Spinner from "react-bootstrap/Spinner";
import { useParams } from "react-router";
import { useLoad } from "../hooks";
import {
  cancelTask,
  loadTask,
  loadTaskErrors,
  loadTaskLogs,
  shortTaskError,
  taskDuration,
  taskErrorHint,
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
    case "SUCCESS":
      return <Notice kind="success">Task succeeded after {d}.</Notice>;
    case "FAILED":
      return (
        <Notice kind="error" data-testid="task-error" title="Error:">
          {shortTaskError(task.errorMessage)}
          {taskErrorHint(task.errorMessage) && <div className="mt-1">{taskErrorHint(task.errorMessage)}</div>}
          <details className="mt-2">
            <summary>Full message</summary>
            <pre className="mb-0 text-break" style={{ whiteSpace: "pre-wrap" }}>
              {task.errorMessage}
            </pre>
          </details>
        </Notice>
      );
    case "CANCELED":
      return <Notice kind="warning">Task canceled.</Notice>;
    case "CANCELING":
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

  const errors = failed.errors || [];
  const unignored = errors.filter((e) => !e.ignored);

  return (
    <Loaded state={state}>
      {(task) => (
        <Page
          title={`${task.kind}: ${task.description}`}
          back="/tasks"
          backLabel="Tasks"
          actions={
            task.status === "RUNNING" && (
              <Button variant="danger" onClick={() => cancelTask(task.id)}>
                Stop
              </Button>
            )
          }
        >
          <Summary task={task} />
          {errors.length > 0 && (
            <Notice kind="warning">
              <span data-testid="failed-files-summary">
                {unignored.length.toLocaleString("en-US")} {unignored.length === 1 ? "file" : "files"} could not be
                backed up.
                {errors.length - unignored.length > 0 && (
                  <span className="nx-muted">
                    {" "}
                    {(errors.length - unignored.length).toLocaleString("en-US")} ignored.
                  </span>
                )}
              </span>{" "}
              <Button size="sm" variant="primary" data-testid="show-failed-files" onClick={() => setOpen(true)}>
                Show details
              </Button>
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
                  cell: (r) => (r.units === "bytes" ? <SizeText bytes={r.value} /> : r.value.toLocaleString("en-US")),
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
