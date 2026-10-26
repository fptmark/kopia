import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { describe, it, expect, vi, beforeEach } from "vitest";
import axios from "axios";
import { MemoryRouter, Route, Routes } from "react-router";
import { UIPreferencesContext } from "../../../src/contexts/UIPreferencesContext";
import { Tasks } from "../../../src/next/pages/Tasks";
import { Task } from "../../../src/next/pages/Task";
import { taskQuery, taskStatus } from "../../../src/next/tasks";

vi.mock("axios");

const task = (id, over = {}) => ({
  id,
  kind: "Snapshot",
  description: "me@mac:/Users/me at 2026-10-23T17:00:00Z",
  status: "SUCCESS",
  startTime: "2026-10-23T17:00:00Z",
  endTime: "2026-10-23T17:05:00Z",
  failedFiles: 0,
  ...over,
});

const prefs = { pageSize: 25, bytesStringBase2: false };

const renderTasks = () =>
  render(
    <MemoryRouter>
      <UIPreferencesContext.Provider value={prefs}>
        <Tasks />
      </UIPreferencesContext.Provider>
    </MemoryRouter>,
  );

describe("Tasks page", () => {
  beforeEach(() => {
    axios.get.mockReset();
    axios.post.mockReset().mockResolvedValue({ data: {} });
  });

  it("opens a finished snapshot in the snapshot browser and any other task on its own page", async () => {
    axios.get.mockResolvedValue({
      data: {
        history: true,
        total: 3,
        kinds: [],
        tasks: [
          task("a"),
          task("b", { status: "FAILED" }),
          task("c", { kind: "Maintenance", description: "Periodic maintenance" }),
        ],
      },
    });
    renderTasks();
    await waitFor(() => expect(screen.getAllByTestId("task-started")).toHaveLength(3));
    expect(screen.getAllByTestId("task-started").map((a) => a.getAttribute("href"))).toEqual([
      "/snapshots/of-task/a",
      "/tasks/b",
      "/tasks/c",
    ]);
  });

  it("lists tasks in words, with how each ended", async () => {
    axios.get.mockResolvedValue({
      data: {
        history: true,
        total: 3,
        kinds: ["Snapshot", "Maintenance"],
        tasks: [
          task("a"),
          task("b", { status: "FAILED", errorMessage: "dial tcp 10.0.0.2:22: connect: no route to host" }),
          task("c", { kind: "Maintenance", description: "Periodic maintenance", status: "SUCCESS", failedFiles: 6 }),
        ],
      },
    });
    renderTasks();
    await waitFor(() => expect(screen.getAllByText("Snapshot of /Users/me").length).toBe(2));

    expect(screen.getAllByText("Finished in 5 min")).toHaveLength(2);
    expect(screen.getByText(/Failed after 5 min/)).toBeInTheDocument();
    expect(screen.getByTestId("task-error-inline")).toHaveTextContent("connect: no route to host");
    expect(screen.getByText("Repository maintenance (periodic)")).toBeInTheDocument();
    expect(screen.getByTestId("tasks-summary")).toHaveTextContent("Showing 3 of 3 tasks");
  });

  it("explains a failed task and the files a snapshot skipped", async () => {
    axios.get.mockImplementation((url) => {
      if (url.endsWith("/errors")) {
        return Promise.resolve({
          data: {
            errors: [{ path: "Library/Mail/x", error: "operation not permitted" }],
            source: "/Users/me",
            userName: "me",
            host: "mac",
          },
        });
      }
      return Promise.resolve({
        data: {
          history: true,
          total: 2,
          tasks: [task("b", { status: "FAILED", errorMessage: "no route to host" }), task("c", { failedFiles: 1 })],
        },
      });
    });
    renderTasks();
    await waitFor(() => expect(screen.getAllByTestId("task-status-button")).toHaveLength(2));

    fireEvent.click(screen.getAllByTestId("task-status-button")[0]);
    expect(screen.getByTestId("task-error-dialog")).toHaveTextContent("no route to host");
    fireEvent.click(screen.getByLabelText("Close"));

    fireEvent.click(screen.getAllByTestId("task-status-button")[1]);
    await waitFor(() => expect(screen.getByTestId("snapshot-errors")).toBeInTheDocument());
    expect(screen.getByText("operation not permitted")).toBeInTheDocument();
  });

  it("asks the server for matches when a filter changes", async () => {
    axios.get.mockResolvedValue({ data: { history: true, total: 1, tasks: [task("a")] } });
    renderTasks();
    await waitFor(() => expect(screen.getByText("Snapshot of /Users/me")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "Failed" } });
    await waitFor(() =>
      expect(axios.get).toHaveBeenCalledWith("/api/v1/tasks", {
        params: expect.objectContaining({ status: "FAILED" }),
      }),
    );

    fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-10-01" } });
    await waitFor(() => expect(axios.get.mock.calls.at(-1)[1].params.from).toMatch(/^2026-10-0[1-2]T/));
  });

  it("shows older tasks on request", async () => {
    axios.get.mockImplementation((url, opts) =>
      Promise.resolve({
        data: opts.params.before
          ? { tasks: [task("old", { description: "me@mac:/Old at 2026-10-01T10:00:00Z" })] }
          : { history: true, total: 2, tasks: [task("a")] },
      }),
    );
    renderTasks();
    await waitFor(() => expect(screen.getByTestId("load-older-tasks")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("load-older-tasks"));
    await waitFor(() => expect(screen.getByText("Snapshot of /Old")).toBeInTheDocument());
    expect(axios.get).toHaveBeenCalledWith("/api/v1/tasks", { params: expect.objectContaining({ before: "a" }) });
  });

  it("says what appears here when there are no tasks, and stops a running one", async () => {
    axios.get.mockResolvedValue({ data: { tasks: [] } });
    const { unmount } = renderTasks();
    await waitFor(() => expect(screen.getByText(/A list of tasks will appear here/)).toBeInTheDocument());
    unmount();

    axios.get.mockResolvedValue({ data: { tasks: [task("r", { status: "RUNNING", endTime: undefined })] } });
    renderTasks();
    await waitFor(() => expect(screen.getByText("Stop")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Stop"));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith("/api/v1/tasks/r/cancel", {}));
  });
});

describe("task helpers", () => {
  it("builds the query from the filters", () => {
    expect(taskQuery({ status: "All", kind: "All", search: "", from: "", to: "" })).toEqual({ limit: 100 });
    const q = taskQuery({ status: "Failed", kind: "Snapshot", search: "dial", from: "2026-10-01", to: "2026-10-02" });
    expect(q).toMatchObject({ limit: 100, status: "FAILED", kind: "Snapshot", q: "dial" });
    expect(new Date(q.from).getTime()).toBeLessThan(new Date(q.to).getTime());
  });

  it("gives each status its kind of badge", () => {
    expect(taskStatus(task("x")).kind).toBe("ok");
    expect(taskStatus(task("x", { failedFiles: 2 })).kind).toBe("warning");
    expect(taskStatus(task("x", { status: "FAILED" })).kind).toBe("error");
    expect(taskStatus(task("x", { status: "CANCELED" })).kind).toBe("neutral");
    expect(taskStatus(task("x", { status: "RUNNING", endTime: undefined })).kind).toBe("running");
  });
});

describe("Task page", () => {
  const renderTask = () =>
    render(
      <MemoryRouter initialEntries={["/tasks/t1"]}>
        <UIPreferencesContext.Provider value={prefs}>
          <Routes>
            <Route path="/tasks/:tid" element={<Task />} />
          </Routes>
        </UIPreferencesContext.Provider>
      </MemoryRouter>,
    );

  const serve = (t, extra = {}) =>
    axios.get.mockImplementation((url) => {
      if (url.endsWith("/logs")) {
        return Promise.resolve({ data: { logs: [{ ts: 1790000000, level: "info", msg: "snapshotting", mod: "x" }] } });
      }
      if (url.endsWith("/errors")) {
        return Promise.resolve({ data: extra.errors ?? { errors: [] } });
      }
      if (url.startsWith("/api/v1/snapshots?")) {
        return Promise.resolve({ data: extra.history ?? { snapshots: [] } });
      }
      return Promise.resolve({ data: t });
    });

  beforeEach(() => {
    axios.get.mockReset();
    axios.post.mockReset().mockResolvedValue({ data: {} });
  });

  it("shows a finished task with its counters and log", async () => {
    serve(
      task("t1", {
        counters: {
          "Hashed files": { value: 1234 },
          "Hashed bytes": { value: 5e9, units: "bytes" },
          Zero: { value: 0 },
        },
      }),
    );
    renderTask();
    await waitFor(() => expect(screen.getByText("Task succeeded after 5 min.")).toBeInTheDocument());

    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("5 GB")).toBeInTheDocument();
    expect(screen.queryByText("Zero")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/snapshotting/)).toBeInTheDocument());
  });

  it("explains a failure, with the hint for a known cause", async () => {
    serve(task("t1", { status: "FAILED", errorMessage: "dial tcp: connect: no route to host" }));
    renderTask();
    await waitFor(() => expect(screen.getByTestId("task-error")).toBeInTheDocument());
    expect(screen.getByTestId("task-error")).toHaveTextContent("Local Network permission");
  });

  it("offers the failed files of a snapshot", async () => {
    serve(task("t1"), { errors: { errors: [{ path: "a/b", error: "permission denied" }], source: "/Users/me" } });
    renderTask();
    await waitFor(() =>
      expect(screen.getByTestId("failed-files-summary")).toHaveTextContent("1 file could not be backed up"),
    );
    fireEvent.click(screen.getByTestId("show-failed-files"));
    expect(screen.getByTestId("snapshot-errors")).toBeInTheDocument();
  });

  it("links a snapshot task to the snapshot it made", async () => {
    serve(task("t1"), {
      errors: { errors: [], source: "/Users/me", userName: "me", host: "mac", snapshotId: "s2" },
      history: {
        snapshots: [
          { id: "s1", rootID: "kold", startTime: "2026-10-26T13:00:00Z" },
          { id: "s2", rootID: "knew", startTime: "2026-10-26T14:00:00Z" },
        ],
      },
    });
    renderTask();
    const view = await screen.findByText("View snapshot");
    expect(view.closest("a")).toHaveAttribute("href", "/snapshots/dir/knew");
  });

  it("has no snapshot link for a task that made no snapshot", async () => {
    serve(task("t1"), { errors: { errors: [], source: "/Users/me", userName: "me", host: "mac" } });
    renderTask();
    await waitFor(() => expect(screen.getByText("Task succeeded after 5 min.")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "View snapshot" })).not.toBeInTheDocument();
  });

  it("can stop a running task", async () => {
    serve(task("t1", { status: "RUNNING", endTime: undefined, progressInfo: "10 files" }));
    renderTask();
    await waitFor(() => expect(screen.getByText(/Running for/)).toBeInTheDocument());
    fireEvent.click(screen.getAllByText("Stop")[0]);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith("/api/v1/tasks/t1/cancel", {}));
  });
});
