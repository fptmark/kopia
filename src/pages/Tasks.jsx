import { faInfoCircle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import axios from "axios";
import moment from "moment";
import React, { Component } from "react";
import Alert from "react-bootstrap/Alert";
import Button from "react-bootstrap/Button";
import Col from "react-bootstrap/Col";
import Dropdown from "react-bootstrap/Dropdown";
import Form from "react-bootstrap/Form";
import Row from "react-bootstrap/Row";
import { Link } from "react-router";
import KopiaTable from "../components/KopiaTable";
import { shortTaskError, taskDescription, taskStatusSymbol } from "../utils/taskutil";
import { redirect, showFailures, showTaskError } from "../utils/uiutil";

const PAGE_SIZE = 100;
const STATUSES = ["Running", "Success", "Failed", "Canceled"];
const SEARCH_DELAY_MS = 300;

/**
 * Query parameters asking the server for the tasks that match the filters.
 */
export function taskQuery({ showStatus, showKind, searchDescription, from, to }) {
  const q = { limit: PAGE_SIZE };

  if (showStatus !== "All") {
    q.status = showStatus.toUpperCase();
  }
  if (showKind !== "All") {
    q.kind = showKind;
  }
  if (searchDescription) {
    q.q = searchDescription;
  }
  if (from) {
    q.from = new Date(from + "T00:00:00").toISOString();
  }
  if (to) {
    q.to = new Date(to + "T23:59:59.999").toISOString();
  }

  return q;
}

function failedFilesTitle(t) {
  return (
    t.failedFiles.toLocaleString() +
    (t.failedFiles === 1 ? " file" : " files") +
    " could not be backed up (click for details)"
  );
}

/** Opens the dialog behind a task's status icon: the error of a failed task, or the files a snapshot skipped. */
function openTaskDetails(t) {
  if (t.status === "FAILED" && t.errorMessage) {
    showTaskError({ taskId: t.id, title: taskDescription(t), message: t.errorMessage });
    return;
  }

  axios
    .get("/api/v1/tasks/" + t.id + "/errors")
    .then((result) =>
      showFailures({
        numFailed: t.failedFiles,
        ignored: t.ignoredFiles || 0,
        errors: result.data.errors || [],
        source: result.data.source,
        userName: result.data.userName,
        host: result.data.host,
        taskId: t.id,
      }),
    )
    .catch((e) =>
      showTaskError({
        taskId: t.id,
        title: taskDescription(t),
        message: "Unable to load the failed files: " + e.message,
      }),
    );
}

export class Tasks extends Component {
  constructor() {
    super();
    this.state = {
      items: [],
      older: [],
      total: 0,
      history: false,
      isLoading: true,
      isLoadingMore: false,
      error: null,
      showKind: "All",
      showStatus: "All",
      uniqueKinds: [],
      searchDescription: "",
      from: "",
      to: "",
    };

    this.fetchTasks = this.fetchTasks.bind(this);
    this.loadOlder = this.loadOlder.bind(this);
    this.filtersChanged = this.filtersChanged.bind(this);
    this.interval = window.setInterval(this.fetchTasks, 3000);
  }

  componentDidMount() {
    this.mounted = true;
    this.fetchTasks();
  }

  componentWillUnmount() {
    this.mounted = false;
    window.clearInterval(this.interval);
    window.clearTimeout(this.searchTimer);
  }

  getUniqueKinds(tasks) {
    let o = {};

    for (const tsk of tasks) {
      o[tsk.kind] = true;
    }

    let result = [];
    for (const kind in o) {
      result.push(kind);
    }

    return result;
  }

  // The newest page is refreshed regularly; older pages that were loaded stay as they are.
  fetchTasks() {
    axios
      .get("/api/v1/tasks", { params: taskQuery(this.state) })
      .then((result) => {
        if (!this.mounted) {
          return;
        }

        const items = result.data.tasks;
        const kinds = result.data.kinds && result.data.kinds.length ? result.data.kinds : this.getUniqueKinds(items);

        this.setState((s) => {
          const ids = new Set(items.map((t) => t.id));

          return {
            items,
            older: s.older.filter((t) => !ids.has(t.id)),
            total: result.data.total !== undefined ? result.data.total : items.length,
            history: !!result.data.history,
            uniqueKinds: kinds,
            isLoading: false,
          };
        });
      })
      .catch((error) => {
        redirect(error);
        this.setState({
          error,
          isLoading: false,
        });
      });
  }

  loadOlder() {
    const all = [...this.state.items, ...this.state.older];
    if (!all.length) {
      return;
    }

    this.setState({ isLoadingMore: true });

    axios
      .get("/api/v1/tasks", { params: { ...taskQuery(this.state), before: all[all.length - 1].id } })
      .then((result) => {
        if (this.mounted) {
          this.setState((s) => ({ older: [...s.older, ...result.data.tasks], isLoadingMore: false }));
        }
      })
      .catch(() => {
        if (this.mounted) {
          this.setState({ isLoadingMore: false });
        }
      });
  }

  // Changing a filter starts again from the newest tasks and asks the server for matches.
  filtersChanged(delay) {
    window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(
      () => {
        this.setState({ older: [] }, this.fetchTasks);
      },
      delay ? SEARCH_DELAY_MS : 0,
    );
  }

  setFilter(change, delay) {
    this.setState(change, () => this.filtersChanged(delay));
  }

  taskMatches(t) {
    if (this.state.showKind !== "All" && t.kind !== this.state.showKind) {
      return false;
    }

    if (this.state.showStatus !== "All" && t.status.toLowerCase() !== this.state.showStatus.toLowerCase()) {
      return false;
    }

    if (
      this.state.searchDescription &&
      (t.description + "\n" + (t.errorMessage || ""))
        .toLowerCase()
        .indexOf(this.state.searchDescription.toLowerCase()) < 0
    ) {
      return false;
    }

    const started = new Date(t.startTime).getTime();
    if (this.state.from && started < new Date(this.state.from + "T00:00:00").getTime()) {
      return false;
    }
    if (this.state.to && started > new Date(this.state.to + "T23:59:59.999").getTime()) {
      return false;
    }

    return true;
  }

  filterItems(items) {
    return items.filter((c) => this.taskMatches(c));
  }

  render() {
    const { items, older, total, history, isLoading, isLoadingMore, error } = this.state;
    if (error) {
      return <p>{error.message}</p>;
    }
    if (isLoading) {
      return <p>Loading ...</p>;
    }

    const columns = [
      {
        header: "Started",
        width: 190,
        cell: (x) => (
          <Link
            to={"/tasks/" + x.row.original.id}
            title={moment(x.row.original.startTime).fromNow()}
            data-testid="task-started"
          >
            {moment(x.row.original.startTime).format("MMM D, YYYY h:mm:ss A")}
          </Link>
        ),
      },
      {
        header: "Status",
        width: 250,
        cell: (x) => {
          const t = x.row.original;
          const hasError = t.status === "FAILED" && t.errorMessage;
          if (!hasError && !(t.failedFiles > 0)) {
            return taskStatusSymbol(t);
          }
          // the exclamation icon is the way to the details
          return taskStatusSymbol(t, (icon) => (
            <button
              type="button"
              className="btn btn-link p-0 align-baseline"
              title={hasError ? shortTaskError(t.errorMessage) + " (click for details)" : failedFilesTitle(t)}
              aria-label={hasError ? "Show the error" : "Show the files that failed"}
              onClick={() => openTaskDetails(t)}
              data-testid="task-status-button"
            >
              {icon}
            </button>
          ));
        },
      },
      {
        header: "Kind",
        width: 110,
        cell: (x) => <p>{x.row.original.kind}</p>,
      },
      {
        header: "Description",
        width: "",
        cell: (x) => {
          const t = x.row.original;
          return (
            <p title={t.description}>
              {taskDescription(t)}
              {t.status === "FAILED" && t.errorMessage && (
                <span className="text-danger" data-testid="task-error-inline">
                  {" "}
                  · {shortTaskError(t.errorMessage)}
                </span>
              )}
            </p>
          );
        },
      },
    ];

    const shown = [...items, ...older];
    const filteredItems = this.filterItems(shown);
    const hasMore = history && shown.length < total;
    const filtering =
      this.state.showStatus !== "All" ||
      this.state.showKind !== "All" ||
      this.state.searchDescription ||
      this.state.from ||
      this.state.to;

    return (
      <>
        <Form onSubmit={(e) => e.preventDefault()}>
          <div className="list-actions">
            <Row className="g-2 align-items-center">
              <Col xs="auto">
                <Dropdown>
                  <Dropdown.Toggle size="sm" variant="primary">
                    Status: {this.state.showStatus}
                  </Dropdown.Toggle>
                  <Dropdown.Menu>
                    <Dropdown.Item onClick={() => this.setFilter({ showStatus: "All" })}>All</Dropdown.Item>
                    <Dropdown.Divider />
                    {STATUSES.map((st) => (
                      <Dropdown.Item key={st} onClick={() => this.setFilter({ showStatus: st })}>
                        {st}
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Menu>
                </Dropdown>
              </Col>
              <Col xs="auto">
                <Dropdown>
                  <Dropdown.Toggle size="sm" variant="primary">
                    Kind: {this.state.showKind}
                  </Dropdown.Toggle>
                  <Dropdown.Menu>
                    <Dropdown.Item onClick={() => this.setFilter({ showKind: "All" })}>All</Dropdown.Item>
                    <Dropdown.Divider />
                    {this.state.uniqueKinds.map((k) => (
                      <Dropdown.Item key={k} onClick={() => this.setFilter({ showKind: k })}>
                        {k}
                      </Dropdown.Item>
                    ))}
                  </Dropdown.Menu>
                </Dropdown>
              </Col>
              <Col xs="auto">
                <Form.Control
                  size="sm"
                  type="date"
                  aria-label="From date"
                  data-testid="tasks-from"
                  value={this.state.from}
                  max={this.state.to || undefined}
                  onChange={(e) => this.setFilter({ from: e.target.value })}
                />
              </Col>
              <Col xs="auto">
                <Form.Control
                  size="sm"
                  type="date"
                  aria-label="To date"
                  data-testid="tasks-to"
                  value={this.state.to}
                  min={this.state.from || undefined}
                  onChange={(e) => this.setFilter({ to: e.target.value })}
                />
              </Col>
              <Col xs={12} md>
                <Form.Control
                  size="sm"
                  type="text"
                  name="searchDescription"
                  placeholder="search description and errors"
                  value={this.state.searchDescription}
                  onChange={(e) => this.setFilter({ searchDescription: e.target.value }, true)}
                  autoFocus={true}
                />
              </Col>
            </Row>
          </div>
          <Row>
            <Col>
              {!items.length && !older.length && !filtering ? (
                <Alert variant="info">
                  <FontAwesomeIcon size="sm" icon={faInfoCircle} /> A list of tasks will appear here when you create
                  snapshots, restore, run maintenance, etc.
                </Alert>
              ) : (
                <>
                  <div className="small text-muted my-2" data-testid="tasks-summary">
                    {history
                      ? "Showing " +
                        Math.min(shown.length, total).toLocaleString() +
                        " of " +
                        total.toLocaleString() +
                        " tasks. Tasks are kept permanently, so this includes earlier server runs."
                      : "Only recent tasks are available; they are lost when the server restarts."}
                  </div>
                  <KopiaTable data={filteredItems} columns={columns} />
                  {hasMore && (
                    <div className="text-center my-3">
                      <Button
                        size="sm"
                        variant="primary"
                        data-testid="load-older-tasks"
                        disabled={isLoadingMore}
                        onClick={this.loadOlder}
                      >
                        {isLoadingMore ? "Loading..." : "Show older tasks"}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </Col>
          </Row>
        </Form>
      </>
    );
  }
}
