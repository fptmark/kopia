import React, { useMemo, useState } from "react";
import { formatCount } from "../format";
import Button from "react-bootstrap/Button";
import Form from "react-bootstrap/Form";
import { Link } from "react-router";
import { policyEditorURL } from "../../utils/policyutil";
import { errorMessage } from "../api";
import { loadHealth } from "../health";
import { useDebounced, useLoad } from "../hooks";
import { sourceString } from "../snapshots";
import {
  cancelTask,
  failedWithMessage,
  isRunning,
  isSuccess,
  loadTaskErrors,
  loadTasks,
  loadUpcomingTasks,
  shortTaskError,
  TASK_STATUSES,
  taskDescription,
  taskStatus,
  verifyTaskPercent,
} from "../tasks";
import {
  DataTable,
  DateTimeText,
  EmptyState,
  FailedFilesDialog,
  Loaded,
  Notice,
  Page,
  ProgressBit,
  SearchBox,
  StatusBadge,
  TabNav,
  TaskErrorDialog,
  Toolbar,
} from "../ui";

/** The status of a task: its badge, a running Verify's progress bar, and, for one that failed or skipped
 * files, the button that explains it. */
function StatusCell({ task, onDetails, onCancel }) {
  const s = taskStatus(task);
  const hasError = failedWithMessage(task);
  const skipped = task.failedFiles > 0;
  const verifying = isRunning(task) && task.kind === "Verify";

  return (
    <span className="nx-inline">
      <StatusBadge kind={s.kind}>{s.text}</StatusBadge>
      {verifying && (
        <span className="nx-inline" data-testid="task-verify-progress">
          <ProgressBit percent={verifyTaskPercent(task)} ariaLabel="Verification progress" />
          <span className="nx-muted small">{task.progressInfo}</span>
        </span>
      )}
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
      {isRunning(task) && (
        <Button size="sm" variant="secondary" onClick={() => onCancel(task)}>
          Stop
        </Button>
      )}
    </span>
  );
}

const UPCOMING_LIMITS = [10, 25, 50, 100];

/** What's scheduled next across every source, soonest first; "Show" picks how many to ask the server for. */
function FutureTasks() {
  const [limit, setLimit] = useState(UPCOMING_LIMITS[0]);
  const state = useLoad(() => loadUpcomingTasks(limit), [limit], { refreshMs: 60000 });
  const tasks = state.data?.tasks ?? [];

  const columns = [
    {
      id: "time",
      header: "Scheduled for",
      accessor: (t) => t.time,
      cell: (t) => <DateTimeText long value={t.time} />,
    },
    { id: "kind", header: "Kind", accessor: (t) => t.kind },
    {
      id: "source",
      header: "Source",
      accessor: (t) => sourceString(t.source),
      cell: (t) => (
        <Link to={policyEditorURL(t.source)} data-testid="future-task-source">
          {sourceString(t.source)}
        </Link>
      ),
    },
  ];

  return (
    <>
      <Toolbar>
        <Toolbar.Group label="Show">
          <Form.Select
            size="sm"
            aria-label="How many upcoming tasks to show"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            {UPCOMING_LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Form.Select>
        </Toolbar.Group>
      </Toolbar>
      <Loaded state={state}>
        {() =>
          tasks.length === 0 ? (
            <EmptyState>Nothing is scheduled: every source is manual, or has no schedule set.</EmptyState>
          ) : (
            <DataTable
              label="upcoming tasks"
              data={tasks}
              columns={columns}
              getRowId={(t) => t.kind + "/" + sourceString(t.source) + "/" + t.time}
              initialSort={{ id: "time", desc: false }}
              emptyText="Nothing is scheduled."
            />
          )
        }
      </Loaded>
    </>
  );
}

function TaskHistory() {
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

  // Verify tasks whose result found a previous failure of the same source and mode passing again
  const health = useLoad(loadHealth, [], { refreshMs: 60000 });
  const clearedIds = useMemo(() => new Set(health.data?.clearedTaskIds ?? []), [health.data]);

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
    if (failedWithMessage(t)) {
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
          to={(t.kind === "Snapshot" && isSuccess(t) ? "/snapshots/of-task/" : "/tasks/") + t.id}
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
          {failedWithMessage(t) && (
            <span className="text-danger" data-testid="task-error-inline">
              {" "}
              · {shortTaskError(t.errorMessage)}
            </span>
          )}
          {isSuccess(t) && clearedIds.has(t.id) && (
            <span className="text-success" data-testid="task-cleared-inline">
              {" "}
              · cleared a previous failure
            </span>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
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
    </>
  );
}

const TASK_TABS = [
  { id: "history", label: "History" },
  { id: "future", label: "Future" },
];

export function Tasks() {
  const [tab, setTab] = useState("history");

  return (
    <Page title="Tasks">
      <TabNav tabs={TASK_TABS} active={tab} onChange={setTab} />
      {tab === "history" ? <TaskHistory /> : <FutureTasks />}
    </Page>
  );
}
