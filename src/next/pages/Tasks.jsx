import React, { useMemo, useState } from "react";
import { formatCount } from "../format";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { Link } from "react-router";
import { errorMessage } from "../api";
import { useDebounced, useLoad } from "../hooks";
import {
  cancelTask,
  loadTaskErrors,
  loadTasks,
  shortTaskError,
  TASK_STATUSES,
  taskDescription,
  taskStatus,
} from "../tasks";
import {
  DataTable,
  DateTimeText,
  EmptyState,
  FailedFilesDialog,
  Loaded,
  Notice,
  Page,
  SearchBox,
  StatusBadge,
  TaskErrorDialog,
  Toolbar,
} from "../ui";

/** The status of a task and, for one that failed or skipped files, the button that explains it. */
function StatusCell({ task, onDetails, onCancel }) {
  const s = taskStatus(task);
  const hasError = task.status === "FAILED" && task.errorMessage;
  const skipped = task.failedFiles > 0;

  return (
    <span className="nx-inline">
      <StatusBadge kind={s.kind}>{s.text}</StatusBadge>
      {(hasError || skipped) && (
        <Button
          size="sm"
          variant="secondary"
          data-testid="task-status-button"
          aria-label={hasError ? "Show the error" : "Show the files that failed"}
          title={
            hasError
              ? shortTaskError(task.errorMessage)
              : `${formatCount(task.failedFiles)} files could not be backed up`
          }
          onClick={() => onDetails(task)}
        >
          {hasError ? "Why" : `${formatCount(task.failedFiles)} failed`}
        </Button>
      )}
      {task.status === "RUNNING" && (
        <Button size="sm" variant="secondary" onClick={() => onCancel(task)}>
          Stop
        </Button>
      )}
    </span>
  );
}

export function Tasks() {
  const [status, setStatus] = useState("All");
  const [kind, setKind] = useState("All");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [search, setSearch] = useState("");
  const typed = useDebounced(search, 300);
  const filters = useMemo(() => ({ status, kind, search: typed, from, to }), [status, kind, typed, from, to]);

  const [older, setOlder] = useState({ key: "", tasks: [] });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [message, setMessage] = useState(null);

  const state = useLoad(() => loadTasks(filters), [filters], { refreshMs: 3000 });
  const key = JSON.stringify(filters);

  const first = state.data?.tasks ?? [];
  const olderTasks = older.key === key ? older.tasks.filter((t) => !first.some((f) => f.id === t.id)) : [];
  const shown = [...first, ...olderTasks];
  const total = state.data?.total ?? shown.length;
  const history = !!state.data?.history;
  const kinds = state.data?.kinds?.length ? state.data.kinds : [...new Set(first.map((t) => t.kind))];
  const filtering = status !== "All" || kind !== "All" || typed || from || to;

  const showOlder = () => {
    setLoadingOlder(true);
    loadTasks(filters, shown[shown.length - 1].id)
      .then((r) => setOlder({ key, tasks: [...olderTasks, ...r.tasks] }))
      .catch((e) => setMessage(`Could not load older tasks: ${errorMessage(e)}`))
      .finally(() => setLoadingOlder(false));
  };

  const details = (t) => {
    if (t.status === "FAILED" && t.errorMessage) {
      setDialog({ error: { taskId: t.id, title: taskDescription(t), message: t.errorMessage } });
      return;
    }
    loadTaskErrors(t.id)
      .then((r) =>
        setDialog({
          failures: {
            numFailed: t.failedFiles,
            ignored: t.ignoredFiles || 0,
            errors: r.errors || [],
            source: r.source,
            userName: r.userName,
            host: r.host,
            taskId: t.id,
          },
        }),
      )
      .catch((e) =>
        setDialog({
          error: {
            taskId: t.id,
            title: taskDescription(t),
            message: "Unable to load the failed files: " + errorMessage(e),
          },
        }),
      );
  };

  const columns = [
    {
      id: "started",
      header: "Started",
      accessor: (t) => t.startTime,
      cell: (t) => (
        <Link
          to={(t.kind === "Snapshot" && t.status === "SUCCESS" ? "/snapshots/of-task/" : "/tasks/") + t.id}
          data-testid="task-started"
        >
          <DateTimeText value={t.startTime} />
        </Link>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessor: (t) => t.status,
      cell: (t) => <StatusCell task={t} onDetails={details} onCancel={(x) => cancelTask(x.id).then(state.refresh)} />,
    },
    { id: "kind", header: "Kind", accessor: (t) => t.kind },
    {
      id: "description",
      header: "What",
      accessor: (t) => taskDescription(t),
      cell: (t) => (
        <span title={t.description}>
          {taskDescription(t)}
          {t.status === "FAILED" && t.errorMessage && (
            <span className="text-danger" data-testid="task-error-inline">
              {" "}
              · {shortTaskError(t.errorMessage)}
            </span>
          )}
        </span>
      ),
    },
  ];

  return (
    <Page title="Tasks">
      {message && (
        <Notice kind="error" onClose={() => setMessage(null)}>
          {message}
        </Notice>
      )}
      <Toolbar>
        <Toolbar.Group label="Filter" grow>
          <Form.Select size="sm" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="All">Any status</option>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Form.Select>
          <Form.Select size="sm" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="All">Any kind</option>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Form.Select>
          <Form.Control
            size="sm"
            type="date"
            aria-label="From date"
            data-testid="tasks-from"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
          <Form.Control
            size="sm"
            type="date"
            aria-label="To date"
            data-testid="tasks-to"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
          <SearchBox value={search} onChange={setSearch} placeholder="Search descriptions and errors" label="Search" />
        </Toolbar.Group>
      </Toolbar>

      <Loaded state={state}>
        {() =>
          shown.length === 0 && !filtering ? (
            <EmptyState>
              A list of tasks will appear here when you create snapshots, restore, run maintenance and so on.
            </EmptyState>
          ) : (
            <>
              <div className="nx-meta" data-testid="tasks-summary">
                <span>
                  {history
                    ? `Showing ${formatCount(Math.min(shown.length, total))} of ${formatCount(total)} tasks`
                    : "Recent tasks only"}
                </span>
                {history && shown.length < total && (
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="load-older-tasks"
                    disabled={loadingOlder}
                    onClick={showOlder}
                  >
                    {loadingOlder ? "Loading" : "Show older tasks"}
                  </Button>
                )}
              </div>
              <DataTable
                label="tasks"
                data={shown}
                columns={columns}
                getRowId={(t) => t.id}
                initialSort={{ id: "started", desc: true }}
                emptyText="No task matches the filters."
              />
            </>
          )
        }
      </Loaded>

      {dialog?.error && <TaskErrorDialog info={dialog.error} onClose={() => setDialog(null)} />}
      {dialog?.failures && <FailedFilesDialog summ={dialog.failures} onClose={() => setDialog(null)} />}
    </Page>
  );
}
